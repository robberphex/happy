import { LarkClient } from "../lark/client.mjs"
import { HappyClient } from "../happy/HappyClient.mjs"
import { HappyEncryption } from "../happy/HappyEncryption.mjs"
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

  /**
   * @param {LarkClient} larkClient
   * @param {HappyClient} happyClient
   */
  constructor(larkClient, happyClient) {
    this.#larkClient = larkClient
    this.#happyClient = happyClient
  }

  /**
   * @returns {Promise<void>}
   */
  async startApi() {

    // Configure
    console.log('Starting API...');

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
   * Handles a parsed message.
   * @param {ParsedMessage} message
   * @returns {Promise<void>}
   */
  async handleMessage(message) {
    console.log(message);
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
      const terminalPublicKey = this.#happyClient.decodeBase64(base64PubKey, 'base64url');
      const secret = await this.#happyClient.getRandomBytesAsync(32);
      const encryption = await HappyEncryption.create(secret);
      const token = await this.#happyClient.authGetToken(secret);

      const answerV1 = this.#happyClient.encryptBox(secret, terminalPublicKey);
      const responseV2Bundle = new Uint8Array(encryption.contentDataKey.length + 1);
      responseV2Bundle[0] = 0;
      responseV2Bundle.set(encryption.contentDataKey, 1);
      const answerV2 = this.#happyClient.encryptBox(responseV2Bundle, terminalPublicKey);

      const result = await this.#happyClient.authApprove(token, terminalPublicKey, answerV1, answerV2);
      await this.#larkClient.replyText(message.messageId, `终端授权结果: ${result}`);

      // todo await sleep 5s
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
}
