import { LarkClient } from "../lark/client.mjs"
import { HappyClient } from "../happy/HappyClient.mjs"
import { HappyEncryption } from "../happy/HappyEncryption.mjs"
import { HappyWebSocket } from "../happy/HappyWebSocket.mjs"
import { buildSessionListCard, buildStreamingCard, buildStreamingCloseSettings } from "../lark/cards/index.mjs"
import { AuthCacheService } from "./AuthCacheService.mjs"
import { MessageDedupeService } from "./MessageDedupeService.mjs"
import { text } from "node:stream/consumers"

/**
 * Parsed message payload normalized from Lark events.
 * @typedef {Object} ParsedMessage
 * @property {string} messageId
 * @property {string} chatId
 * @property {"p2p" | "group"} chatType
 * @property {string} senderId
 * @property {string | undefined} [rootId]
 * @property {string} text
 */

/**
 * @class Orchestrator
 * @description Orchestrates operations using LarkClient and HappyClient
 */
export class Orchestrator {
  /** @type {LarkClient} */
  #larkClient
  /** @type {HappyClient} */
  #happyClient
  /** @type {Map<string, { websocket: HappyWebSocket; encryption: any }>} */
  #webSocketMap
  /** @type {AuthCacheService} */
  #authCacheService
  /** @type {MessageDedupeService} */
  #messageDedupeService
  /** @type {Map<string, string>} */
  #sessionToSenderMap
  /** @type {Map<string, { cardId: string; messageId: string; accumulatedText: string; turnId: string }>} */
  #streamingCards
  /** @type {Map<string, { chatId: string; chatType: string; messageId: string; senderId: string; rootId: string | null }>} */
  #localIdToLarkMap
  /** @type {Map<string, { chatId: string; chatType: string; messageId: string; senderId: string; rootId: string | null }>} */
  #sessionToLatestLarkMap

  /**
   * @param {LarkClient} larkClient
   * @param {HappyClient} happyClient
   */
  constructor(larkClient, happyClient) {
    this.#larkClient = larkClient
    this.#happyClient = happyClient
    this.#webSocketMap = new Map()
    this.#authCacheService = new AuthCacheService()
    this.#messageDedupeService = new MessageDedupeService()
    this.#sessionToSenderMap = new Map()
    this.#streamingCards = new Map()
    this.#localIdToLarkMap = new Map()
    this.#sessionToLatestLarkMap = new Map()
  }

  /**
   * @returns {Promise<void>}
   */
  async startApi() {

    console.log('Starting API...');

    await this.#restoreAllWebSocketConnections();

    this.#larkClient.onMessage(async (event) => {
      const eventType = event.event?.event_type;
      console.log('Lark event:', eventType, JSON.stringify(event, null, 2));

      if (eventType === 'im.message.receive_v1') {
        const message = event.event?.message ?? event.event
        const sender = event.event?.sender ?? event.event?.sender

        if (!message || message.message_type !== "text") {
          return
        }

        let contentText = ""
        try {
          const parsedContent = JSON.parse(message.content)
          contentText = parsedContent?.text ?? ""
        } catch {
          return
        }

        if (!contentText.trim()) {
          return
        }

        /** @type {ParsedMessage} */
        const parsedMessage = {
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType: message.chat_type,
          senderId: sender?.sender_id?.open_id ?? "",
          rootId: message.root_id || undefined,
          text: contentText,
        }

        await this.handleMessage(parsedMessage)
      }
    })

    this.#larkClient.onCardAction(async (event) => {
      const action = this.#parseCardActionEvent(event.event)
      if (action) {
        await this.handleCardAction(action)
      }
    })

    await this.#larkClient.startCallback()

    console.log('Happy Lark is running with WebSocket callback...')
  }

  /**
   * Restore all WebSocket connections from auth cache on startup
   * @returns {Promise<void>}
   */
  async #restoreAllWebSocketConnections() {
    try {
      const allAuths = await this.#authCacheService.getAll();
      console.log(`🔌 HappyWebSocket: Found ${allAuths.length} cached auths to restore`);

      for (const auth of allAuths) {
        try {
          const encryption = await HappyEncryption.create(auth.secret);
          await this.#happyClient.fetchActiveSessions(auth.token, encryption);
          const websocket = new HappyWebSocket();
          websocket.connect(auth.token, encryption, {
            getSessionDataKey: (sessionId) => {
              this.#sessionToSenderMap.set(sessionId, auth.senderId);
              return this.#happyClient.getSessionDataKey(sessionId);
            },
            onAgentMessage: (messageData) => {
              this.#handleAgentMessage(auth.senderId, messageData);
            },
          });
          this.#webSocketMap.set(auth.senderId, { websocket, encryption });
          console.log(`🔌 HappyWebSocket: Restored connection for senderId: ${auth.senderId}`);
        } catch (error) {
          console.error(`🔌 HappyWebSocket: Failed to restore connection for ${auth.senderId}:`, error);
        }
      }
    } catch (error) {
      console.error('🔌 HappyWebSocket: Failed to restore WebSocket connections:', error);
    }
  }

  /**
   * Handles a parsed message.
   * @param {ParsedMessage} message
   * @returns {Promise<void>}
   */
  async handleMessage(message) {
    const isNew = await this.#messageDedupeService.tryInsert(message.messageId);
    if (!isNew) {
      return;
    }

    console.log(message);

    const trimmedText = message.text.trim();

    if (trimmedText === '/sessions') {
      const auth = await this.#authCacheService.get(message.senderId);
      await this.#handleSessionsCommand(message, auth);
      return;
    }

    if (trimmedText === '/machines') {
      const auth = await this.#authCacheService.get(message.senderId);
      await this.#handleMachinesCommand(message, auth);
      return;
    }

    const base64PubKey = this.#extractTerminalPublicKey(message.text);
    console.log("base64PubKey", base64PubKey);
    if (!base64PubKey) {
      await this.#forwardMessageToSession(message);
      return;
    }

    try {
      let auth = await this.#authCacheService.get(message.senderId);
      if (!auth) {
        const secret = await this.#happyClient.getRandomBytesAsync(32);
        const token = await this.#happyClient.authGetToken(secret);
        auth = { secret, token };
        await this.#authCacheService.set(message.senderId, auth);
      }
      const { secret, token } = auth;
      const encryption = await HappyEncryption.create(secret);

      const terminalPublicKey = this.#happyClient.decodeBase64(base64PubKey, 'base64url');

      const answerV1 = this.#happyClient.encryptBox(secret, terminalPublicKey);
      const responseV2Bundle = new Uint8Array(encryption.contentDataKey.length + 1);
      responseV2Bundle[0] = 0;
      responseV2Bundle.set(encryption.contentDataKey, 1);
      const answerV2 = this.#happyClient.encryptBox(responseV2Bundle, terminalPublicKey);

      const result = await this.#happyClient.authApprove(token, terminalPublicKey, answerV1, answerV2);
      await this.#larkClient.replyText(message.messageId, `终端授权结果: ${result}`);

      if (result === 'approved') {
        console.log('🔌 HappyWebSocket: Starting WebSocket connection...');
        const existingConnection = this.#webSocketMap.get(message.senderId);
        if (existingConnection) {
          existingConnection.websocket.disconnect();
        }

        const activeSessions = await this.#happyClient.fetchActiveSessions(token, encryption);
        const websocket = new HappyWebSocket();
        websocket.connect(token, encryption, {
          getSessionDataKey: (sessionId) => this.#happyClient.getSessionDataKey(sessionId),
        });
        this.#webSocketMap.set(message.senderId, { websocket, encryption });

        // 如果当前 sessionId 为空，设置为最近活跃的 session
        if (!auth.currentSessionId && activeSessions.length > 0) {
          const latestSession = activeSessions
            .slice()
            .sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))[0];
          if (latestSession?.id) {
            await this.#authCacheService.setCurrentSessionId(message.senderId, latestSession.id);
            console.log(`🔌 Set default sessionId: ${latestSession.id}`);
          }
        }
      }
    } catch (error) {
      console.log("error_error", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.#larkClient.replyText(message.messageId, `终端授权失败: ${errMsg}`);
    }
  }

  /**
   * @param {ParsedMessage} message
   * @returns {Promise<void>}
   */
  async #forwardMessageToSession(message) {
    const auth = await this.#authCacheService.get(message.senderId);
    if (!auth) {
      await this.#larkClient.replyText(message.messageId, '请先发送终端认证链接（happy://terminal?...）');
      return;
    }

    try {
      const { secret, token } = auth;
      const encryption = await HappyEncryption.create(secret);

      const sessions = await this.#happyClient.fetchSessions(token, encryption);
      const selectedSessionId = this.#resolveCurrentSessionId(auth.currentSessionId, sessions);
      if (!selectedSessionId) {
        await this.#larkClient.replyText(message.messageId, '当前没有可用 Session，请先发送 /sessions 选择会话');
        return;
      }

      if (selectedSessionId !== auth.currentSessionId) {
        await this.#authCacheService.setCurrentSessionId(message.senderId, selectedSessionId);
      }

      const websocket = await this.#ensureSenderConnection(message.senderId, token, encryption);
      if (!websocket) {
        await this.#larkClient.replyText(message.messageId, '会话连接不可用，请稍后重试');
        return;
      }

      const payload = {
        role: 'user',
        content: {
          type: 'text',
          text: message.text,
        },
        meta: {
          sentFrom: 'happy-lark',
          lark: {
            chatId: message.chatId,
            chatType: message.chatType,
            messageId: message.messageId,
            senderId: message.senderId,
            rootId: message.rootId ?? null,
          }
        }
      };

      const card = buildStreamingCard('');
      const cardId = await this.#larkClient.createCardEntity(card);
      if (!cardId) {
        await this.#larkClient.replyText(message.messageId, '卡片创建失败，请重试');
        return;
      }

      const messageId = await this.#larkClient.replyCardEntity(message.messageId, cardId);
      if (!messageId) {
        await this.#larkClient.replyText(message.messageId, '消息发送失败：卡片发送失败');
        return;
      }

      this.#streamingCards.set(selectedSessionId, {
        cardId,
        messageId,
        accumulatedText: '',
        turnId: null,
        chatId: message.chatId,
        sequence: 1,
      });

      const encryptedMessage = this.#happyClient.encryptSessionMessage(selectedSessionId, encryption, payload);
      const localId = `lark-${message.messageId}`;
      const larkInfo = {
        chatId: message.chatId,
        chatType: message.chatType,
        messageId: message.messageId,
        senderId: message.senderId,
        rootId: message.rootId ?? null,
      };
      this.#localIdToLarkMap.set(localId, larkInfo);
      this.#sessionToLatestLarkMap.set(selectedSessionId, larkInfo);
      const sent = websocket.sendMessage(selectedSessionId, encryptedMessage, localId);
      if (!sent) {
        await this.#larkClient.replyText(message.messageId, '消息发送失败：连接未就绪');
        return;
      }
    } catch (error) {
      console.error("forwardMessageToSession error:", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.#larkClient.replyText(message.messageId, `消息转发失败: ${errMsg}`);
    }
  }

  /**
   * @param {string | undefined} currentSessionId
   * @param {Array<{ id: string; active?: boolean; activeAt?: number; updatedAt?: number }>} sessions
   * @returns {string | null}
   */
  #resolveCurrentSessionId(currentSessionId, sessions) {
    if (currentSessionId && sessions.some((s) => s.id === currentSessionId)) {
      return currentSessionId;
    }

    const active = sessions
      .filter((s) => s.active)
      .sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))[0];
    if (active?.id) {
      return active.id;
    }

    const latest = sessions
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    return latest?.id ?? null;
  }

  /**
   * @param {string} senderId
   * @param {string} token
   * @param {any} encryption
   * @returns {Promise<HappyWebSocket | null>}
   */
  async #ensureSenderConnection(senderId, token, encryption) {
    const existing = this.#webSocketMap.get(senderId);
    if (existing?.websocket?.isConnected()) {
      return existing.websocket;
    }

    if (existing?.websocket) {
      existing.websocket.disconnect();
    }

    await this.#happyClient.fetchActiveSessions(token, encryption);
    const websocket = new HappyWebSocket();
    websocket.connect(token, encryption, {
      getSessionDataKey: (sessionId) => {
        this.#sessionToSenderMap.set(sessionId, senderId);
        return this.#happyClient.getSessionDataKey(sessionId);
      },
      onAgentMessage: (messageData) => {
        this.#handleAgentMessage(senderId, messageData);
      },
    });
    this.#webSocketMap.set(senderId, { websocket, encryption });
    return websocket;
  }

  /**
   * @param {{
   *   openId: string;
   *   openMessageId: string;
   *   openChatId: string;
   *   action: string;
   *   sessionId?: string;
   * }} cardAction
   * @returns {Promise<void>}
   */
  async handleCardAction(cardAction) {
    if (cardAction.action !== "session_select") {
      return;
    }

    if (!cardAction.openId) {
      await this.#replyCardActionFeedback(cardAction, "无法识别用户身份，切换 Session 失败");
      return;
    }

    if (!cardAction.sessionId) {
      await this.#replyCardActionFeedback(cardAction, "未提供 Session ID，无法切换");
      return;
    }

    const auth = await this.#authCacheService.get(cardAction.openId);
    if (!auth) {
      await this.#replyCardActionFeedback(cardAction, "请先完成终端认证，再切换 Session");
      return;
    }

    try {
      const { secret, token } = auth;
      const encryption = await HappyEncryption.create(secret);
      const sessions = await this.#happyClient.fetchSessions(token, encryption);
      const selected = sessions.find((s) => s.id === cardAction.sessionId);

      if (!selected) {
        await this.#replyCardActionFeedback(cardAction, `Session 不存在或已失效: ${cardAction.sessionId}`);
        return;
      }

      await this.#authCacheService.setCurrentSessionId(cardAction.openId, cardAction.sessionId);

      const metadata = selected.metadata || {};
      const summary = metadata.path || metadata.host || selected.id;
      await this.#replyCardActionFeedback(cardAction, `已切换当前 Session: ${summary} (${selected.id})`);
    } catch (error) {
      console.error("handleCardAction error:", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.#replyCardActionFeedback(cardAction, `切换 Session 失败: ${errMsg}`);
    }
  }

  /**
   * @param {unknown} rawEvent
   * @returns {{
   *   openId: string;
   *   openMessageId: string;
   *   openChatId: string;
   *   action: string;
   *   sessionId?: string;
   * } | null}
   */
  #parseCardActionEvent(rawEvent) {
    if (!rawEvent || typeof rawEvent !== "object") {
      return null;
    }

    const event = /** @type {any} */ (rawEvent);
    const value = event.action?.value;
    if (!value || typeof value.action !== "string") {
      return null;
    }

    return {
      openId: event.operator?.open_id ?? "",
      openMessageId: event.context?.open_message_id ?? "",
      openChatId: event.context?.open_chat_id ?? "",
      action: value.action,
      sessionId: value.session_id,
    };
  }

  /**
   * @param {{ openMessageId: string; openChatId: string }} cardAction
   * @param {string} text
   */
  async #replyCardActionFeedback(cardAction, text) {
    if (cardAction.openMessageId) {
      await this.#larkClient.replyText(cardAction.openMessageId, text);
      return;
    }

    if (cardAction.openChatId) {
      await this.#larkClient.sendText(cardAction.openChatId, text);
    }
  }

  /**
   * @param {string} text
   * @returns {string | null}
   */
  #extractTerminalPublicKey(text) {
    const trimmed = text.trim();
    const prefix = 'happy://terminal?';

    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }

    try {
      const url = new URL(trimmed);
      if (url.protocol === 'happy:' && url.hostname === 'terminal') {
        return url.search.slice(1) || null;
      }
    } catch {
      // Ignore invalid URLs and fall through.
    }

    return null;
  }

  /**
   * @param {number} ms
   * @returns {string}
   */
  #formatDuration(ms) {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * @param {ParsedMessage} message
   * @param {{ secret: Uint8Array; token: string; currentSessionId?: string } | null} auth
   * @returns {Promise<void>}
   */
  async #handleSessionsCommand(message, auth) {
    try {
      if (!auth) {
        await this.#larkClient.replyText(message.messageId, '请先进行终端认证后再查看 Session');
        return;
      }

      const { secret, token } = auth;
      const encryption = await HappyEncryption.create(secret);

      const sessions = await this.#happyClient.fetchSessions(token, encryption);
      console.log('fetchSessions result:', JSON.stringify(sessions, null, 2));
      const activeSessions = await this.#happyClient.fetchActiveSessions(token, encryption);
      console.log('fetchActiveSessions result:', JSON.stringify(activeSessions, null, 2));

      const currentActiveSession = activeSessions
        .slice()
        .sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))[0];
      const currentSessionId = currentActiveSession?.id ?? auth.currentSessionId;

      if (currentSessionId !== auth.currentSessionId) {
        await this.#authCacheService.setCurrentSessionId(message.senderId, currentSessionId);
      }

      if (sessions.length === 0) {
        await this.#larkClient.replyText(message.messageId, '暂无 Session');
        return;
      }

      const descriptions = new Map();
      const cardSessions = sessions.map((s) => {
        const metadata = s.metadata || {};
        const tools = metadata.tools || [];
        const slashCommands = metadata.slashCommands || [];
        descriptions.set(
          s.id,
          `${metadata.host || "N/A"} · ${metadata.path || "N/A"} · tools:${tools.length} · cmds:${slashCommands.length}`
        );

        return {
          id: s.id,
          updatedAt: s.updatedAt,
          initialPrompt: metadata.path || metadata.host || s.id,
        };
      });

      const card = buildSessionListCard({
        sessions: cardSessions,
        currentSessionId,
        title: `Session 列表 (${sessions.length})`,
        descriptions,
      });
      await this.#larkClient.replyCard(message.messageId, card);
    } catch (error) {
      console.log("error_error", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.#larkClient.replyText(message.messageId, `获取 Session 失败: ${errMsg}`);
    }
  }

  /**
   * @param {ParsedMessage} message
   * @param {{ secret: Uint8Array; token: string; currentSessionId?: string } | null} auth
   * @returns {Promise<void>}
   */
  async #handleMachinesCommand(message, auth) {
    try {
      if (!auth) {
        await this.#larkClient.replyText(message.messageId, '请先进行终端认证后再查看机器列表');
        return;
      }

      const { secret, token } = auth;
      const encryption = await HappyEncryption.create(secret);

      const machines = await this.#happyClient.fetchMachines(token, encryption);
      console.log(`machines(${machines.length})`);

      if (machines.length === 0) {
        await this.#larkClient.replyText(message.messageId, '暂无机器');
        return;
      }

      const header = '| ID | Name | Metadata版本 | Daemon版本 | Metadata解密 | Daemon解密 | Status |\n|---|---|---|---|---|---|---|';
      const rows = machines.map((m) => {
        return `| ${m.id} | ${m.metadata?.name ?? 'N/A'} | ${m.metadataVersion} | ${m.daemonStateVersion} | ${m.metadata !== null ? '✓' : '✗'} | ${m.daemonState !== null ? '✓' : '✗'} | ${m.daemonState?.status ?? 'N/A'} |`;
      }).join('\n');

      await this.#larkClient.replyMarkdownCard(
        message.messageId,
        `### 机器列表 (${machines.length})\n\n${header}\n${rows}`
      );
    } catch (error) {
      console.log("error_error", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.#larkClient.replyText(message.messageId, `获取机器列表失败: ${errMsg}`);
    }
  }

  /**
   * @param {string} senderId
   * @param {Object} messageData
   * @param {string} messageData.sessionId
   * @param {string} messageData.messageId
   * @param {string} messageData.localId
   * @param {number} messageData.createdAt
   * @param {Object} messageData.event
   * @param {Object} messageData.meta
   * @returns {Promise<void>}
   */
  async #handleAgentMessage(senderId, messageData) {
    const { sessionId, event, meta, turn: turnId } = messageData;
    const eventType = event?.t;

    console.log(`💬 Handling agent event: ${eventType} for session ${sessionId}, turn: ${turnId}`);

    const cardKey = `${sessionId}-${turnId}`;
    const senderCardKey = `${sessionId}-${senderId}`;

    if (eventType === 'turn-start') {
      let chatId, userMessageId;
      if (meta?.lark) {
        chatId = meta.lark.chatId;
        userMessageId = meta.lark.messageId;
      } else if (messageData.localId) {
        const larkInfo = this.#localIdToLarkMap.get(messageData.localId);
        if (larkInfo) {
          chatId = larkInfo.chatId;
          userMessageId = larkInfo.messageId;
          this.#localIdToLarkMap.delete(messageData.localId);
        }
      }

      if (!chatId && !userMessageId) {
        const latestLarkInfo = this.#sessionToLatestLarkMap.get(sessionId);
        if (latestLarkInfo) {
          chatId = latestLarkInfo.chatId;
          userMessageId = latestLarkInfo.messageId;
          this.#sessionToLatestLarkMap.delete(sessionId);
        }
      }

      const existingCardData = this.#streamingCards.get(sessionId) || this.#streamingCards.get(senderCardKey);
      if (existingCardData && existingCardData.turnId === null) {
        existingCardData.turnId = turnId;
        this.#streamingCards.set(cardKey, existingCardData);
        this.#streamingCards.set(senderCardKey, existingCardData);
        console.log(`💬 Reused pre-created card: ${existingCardData.cardId} for turn ${turnId}`);
        return;
      }

      const card = buildStreamingCard('');
      const cardId = await this.#larkClient.createCardEntity(card);
      if (!cardId) {
        console.error('Failed to create streaming card entity');
        return;
      }

      let messageId;
      if (userMessageId) {
        messageId = await this.#larkClient.replyCardEntity(userMessageId, cardId);
      } else if (chatId) {
        console.log(`💬 Sending card to chatId: ${chatId}, cardId: ${cardId}`);
        messageId = await this.#larkClient.sendCardEntity(chatId, cardId);
      }

      if (!messageId) {
        console.error('Failed to send streaming card', { cardId, chatId, userMessageId, sessionId, turnId });
        // 即使发送失败，也存储cardData以便后续更新
        const cardData = {
          cardId,
          messageId: null,
          accumulatedText: '',
          turnId,
          chatId,
          sequence: 1,
          createdAt: Date.now(),
        };
        this.#streamingCards.set(cardKey, cardData);
        this.#streamingCards.set(senderCardKey, cardData);
        this.#streamingCards.set(sessionId, cardData);
        console.log(`💬 Stored failed card data for later recovery: cardId=${cardId}`);
        return;
      }

      const cardData = {
        cardId,
        messageId,
        accumulatedText: '',
        turnId,
        chatId,
        sequence: 1,
        createdAt: Date.now(),
      };

      this.#streamingCards.set(cardKey, cardData);
      this.#streamingCards.set(senderCardKey, cardData);
      this.#streamingCards.set(sessionId, cardData);
      console.log(`💬 Created streaming card: ${cardId} for turn ${turnId}`);

    } else if (eventType === 'text') {
      let cardData = this.#streamingCards.get(cardKey) || this.#streamingCards.get(senderCardKey);
      console.log("debug at 796",cardData);

      if (!cardData) {
        const preCreatedCardData = this.#streamingCards.get(sessionId);
        if (preCreatedCardData) {
          cardData = preCreatedCardData;
          this.#streamingCards.delete(sessionId);
          this.#streamingCards.set(senderCardKey, cardData);
        }
      }

      if (!cardData) {
        const existingCardData = this.#streamingCards.get(senderCardKey);
        const chatId = existingCardData?.chatId;

        if (!chatId) {
          console.log('💬 No chatId available for text event, skipping');
          return;
        }

        const card = buildStreamingCard('');
        const cardId = await this.#larkClient.createCardEntity(card);
        if (!cardId) {
          console.error('Failed to create streaming card entity');
          return;
        }

        console.log(`💬 Sending card to chatId: ${chatId}, cardId: ${cardId}`);
        const messageId = await this.#larkClient.sendCardEntity(chatId, cardId);
        if (!messageId) {
          console.error('Failed to send streaming card');
          return;
        }

        cardData = {
          cardId,
          messageId,
          accumulatedText: '',
          turnId,
          chatId,
          sequence: 1,
          createdAt: Date.now(),
        };

        this.#streamingCards.set(cardKey, cardData);
        this.#streamingCards.set(senderCardKey, cardData);
        console.log(`💬 Created streaming card on text: ${cardId} for turn ${turnId}`);
      }

      const newText = event?.text || '';
      const isThinking = event?.thinking || false;

      // 初始化累积字段
      if (!cardData.accumulatedThinking) {
        cardData.accumulatedThinking = '';
      }

      // 分别累积 thinking 和正文
      if (isThinking) {
        cardData.accumulatedThinking += newText;
      } else {
        cardData.accumulatedText += newText;
      }

      // 确定要更新的元素和内容
      const elementId = isThinking ? 'md_thinking' : 'md_text';
      const content = isThinking
        ? `<font color='grey'>${cardData.accumulatedThinking}</font>`
        : cardData.accumulatedText;

      console.log(`💬 Streaming to card: cardId=${cardData.cardId}, elementId=${elementId}, seq=${cardData.sequence}, thinking=${isThinking}, text=${newText.length} chars`);
      const sequence = cardData.sequence++;
      await this.#larkClient.streamCardText(cardData.cardId, elementId, content, sequence);
      console.log(`💬 Streamed text to card: ${newText.length} chars, seq: ${sequence}, accumulated:${cardData.accumulatedText.length} chars`);

    } else if (eventType === 'tool-call') {
      let cardData = this.#streamingCards.get(cardKey) || this.#streamingCards.get(senderCardKey);
      if (!cardData) {
        const preCreatedCardData = this.#streamingCards.get(sessionId);
        if (preCreatedCardData) {
          cardData = preCreatedCardData;
          this.#streamingCards.delete(sessionId);
        }
      }
      if (!cardData) {
        console.log('💬 No active streaming card for tool-call event, skipping');
        return;
      }

      const toolName = event?.name || 'tool';
      const toolStatus = event?.status;
      const duration = event?.duration ? `${event.duration}ms` : '';

      const toolElement = {
        tag: 'markdown',
        content: `<font color='grey'>🔧 ${toolName}</font> ${toolStatus === 'completed' ? '✓' : toolStatus === 'failed' ? '✗' : '...'} ${duration ? `<font color='grey'>${duration}</font>` : ''}`,
        text_size: 'notation',
        icon: {
          tag: 'standard_icon',
          token: 'code_outlined',
          color: toolStatus === 'completed' ? 'green' : toolStatus === 'failed' ? 'red' : 'grey',
        },
      };

      await this.#larkClient.addCardElements(cardData.cardId, 'insert_before', PROCESSING_ELEMENT_ID, [toolElement], 1);
      console.log(`💬 Added tool-call element: ${toolName}`);

    } else if (eventType === 'turn-end') {
      console.log(`�_debug turn-end: cardKey=${cardKey}, senderCardKey=${senderCardKey}, sessionId=${sessionId}, turnId=${turnId}`);
      console.log(`�_debug turn-end: streamingCards keys=${JSON.stringify([...this.#streamingCards.keys()])}`);
      const cardData = this.#streamingCards.get(cardKey) || this.#streamingCards.get(senderCardKey);
      console.log(`�_debug turn-end: cardData=${JSON.stringify(cardData)}`);
      if (!cardData) {
        console.log('💬 No active streaming card for turn-end event');
        return;
      }

      const status = event?.status || 'completed';
      const summaryText = cardData.accumulatedText.slice(0, 100) || '[完成]';

      // 如果没有 thinking 内容，清空 thinking 元素
      if (!cardData.accumulatedThinking || cardData.accumulatedThinking.length === 0) {
        const seqThinking = cardData.sequence++;
        await this.#larkClient.updateCardElement(
          cardData.cardId,
          'md_thinking',
          {
            tag: 'markdown',
            content: '',
            text_size: 'notation',
            element_id: 'md_thinking',
          },
          seqThinking,
        );
      }

      // 计算耗时并更新 processing_indicator
      const elapsed = this.#formatDuration(Date.now() - (cardData.createdAt || Date.now()));
      const seq = cardData.sequence++;
      await this.#larkClient.updateCardElement(
        cardData.cardId,
        'processing_indicator',
        {
          tag: 'markdown',
          content: `<font color='grey'>${elapsed}</font>`,
          text_size: 'notation',
          element_id: 'processing_indicator',
          icon: {
            tag: 'standard_icon',
            token: 'done_outlined',
            color: 'grey',
          },
        },
        seq,
      );

      const closeSettings = buildStreamingCloseSettings(summaryText);
      await this.#larkClient.updateCardSettings(cardData.cardId, closeSettings, cardData.sequence++);

      this.#streamingCards.delete(cardKey);
      this.#streamingCards.delete(senderCardKey);
      console.log(`💬 Closed streaming card for turn ${turnId} with status: ${status}`);
    }
  }
}
