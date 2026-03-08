import { LarkClient } from "../lark/client.mjs"
import { HappyClient } from "../happy/HappyClient.mjs"
import { HappyEncryption } from "../happy/HappyEncryption.mjs"
import { HappyWebSocket } from "../happy/HappyWebSocket.mjs"
import { buildSessionListCard } from "../lark/cards/index.mjs"
import { AuthCacheService } from "./AuthCacheService.mjs"
import { MessageDedupeService } from "./MessageDedupeService.mjs"
import fastify from "fastify";

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
  }

  /**
   * @returns {Promise<void>}
   */
  async startApi() {

    // Configure
    console.log('Starting API...');

    // Restore all WebSocket connections from cache
    await this.#restoreAllWebSocketConnections();

    // Start API
    const app = fastify({
      // loggerInstance: logger,
      bodyLimit: 1024 * 1024 * 100, // 100MB
    });
    app.register(import('@fastify/cors'), {
      origin: '*',
      allowedHeaders: '*',
      methods: ['GET', 'POST', 'DELETE']
    });
    app.get('/', function (request, reply) {
      reply.send('Welcome to Happy Lark!');
    });
    app.post('/callback/happy-lark/lark/callback', async (request, reply) => {
      const body = request.body || {};
      const eventType = body?.header?.event_type || body?.type;

      if (eventType === 'url_verification') {
        return { challenge: body?.challenge };
      }

      console.log('Lark callback body:', JSON.stringify(body, null, 2));
      return { ok: true };
    });
    app.post('/callback/happy-lark/lark/event', async (request, reply) => {
      console.debug(JSON.stringify(request.body));
      const { header, challenge } = request.body
      const eventType = header?.event_type
      const event = header?.event_type?.startsWith('application.') ? request.body.event : request.body

      console.log(eventType);
      if (eventType === 'url_verification') {
        return { challenge }
      }

      if (eventType === 'application.bot.menu_v6') {
        const { event_key, operator, timestamp } = event
        console.log(`Bot menu clicked: event_key=${event_key}, operator=${operator?.operator_id?.open_id}, timestamp=${timestamp}`)
        return { ok: true };
      } else if (eventType === 'im.message.receive_v1') {
        const message = event?.event?.message ?? event?.message
        const sender = event?.event?.sender ?? event?.sender

        if (!message || message.message_type !== "text") {
          return { ok: true }
        }

        let contentText = ""
        try {
          const parsedContent = JSON.parse(message.content)
          contentText = parsedContent?.text ?? ""
        } catch {
          return { ok: true }
        }

        if (!contentText.trim()) {
          return { ok: true }
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

        return { ok: true };
      }

      const bytes = await this.#happyClient.getRandomBytesAsync(32);

      return { ok: true, bytes: Buffer.from(bytes).toString('base64') }
    });

    await app.listen({ port: 3000, host: '0.0.0.0' });
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
            getSessionDataKey: (sessionId) => this.#happyClient.getSessionDataKey(sessionId),
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
      await this.#larkClient.replyMarkdownCard(
        message.messageId,
        '未识别到终端认证链接，请发送 `happy://terminal?...`'
      );
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

        await this.#happyClient.fetchActiveSessions(token, encryption);
        const websocket = new HappyWebSocket();
        websocket.connect(token, encryption, {
          getSessionDataKey: (sessionId) => this.#happyClient.getSessionDataKey(sessionId),
        });
        this.#webSocketMap.set(message.senderId, { websocket, encryption });
        await this.#larkClient.replyText(message.messageId, `WebSocket 连接已建立，正在监听实时消息...`);
      }

      await new Promise(resolve => setTimeout(resolve, 5000));

      const machines = await this.#happyClient.fetchMachines(token, encryption);
      console.log(`machines(${machines.length})`);
      const preview = machines.map((machine) => ({
        id: machine.id,
        metadataVersion: machine.metadataVersion,
        daemonStateVersion: machine.daemonStateVersion,
        metadataDecrypted: machine.metadata !== null,
        daemonStateDecrypted: machine.daemonState !== null,
        name: machine.metadata?.name ?? null,
        status: machine.daemonState?.status ?? null
      }));
      console.table(preview);
      const mListString = JSON.stringify(machines, null, 2);
      console.log(JSON.stringify(machines, null, 2));
      await this.#larkClient.replyMarkdownCard(message.messageId, `机器列表: \n\`\`\`\n${mListString}\n\`\`\``);
    } catch (error) {
      console.log("error_error", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.#larkClient.replyText(message.messageId, `终端授权失败: ${errMsg}`);
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

      await this.#larkClient.replyText(message.messageId, '正在获取机器列表...');

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
}
