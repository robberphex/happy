import * as lark from "@larksuiteoapi/node-sdk"
import { buildMarkdownCard } from "./cards/index.mjs"
import { createLarkLogger, getLarkLoggerLevel } from "./logger.mjs"

/**
 * @typedef {Object} LarkConfig
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} [domain]
 * @property {string} [docToken]
 */

export class LarkClient {
  /** @type {LarkConfig} */
  #config
  /** @type {import("../utils/logger").Logger} */
  #logger
  /** @type {lark.Client} */
  #sdk

  /**
   * @param {LarkConfig} config
   * @param {import("../utils/logger").Logger} logger
   */
  constructor(config, logger) {
    this.#config = config
    this.#logger = logger

    /** @type {lark.Domain|string} */
    let domain = lark.Domain.Feishu;
    if (config.domain) {
      if ("feishu" === config.domain.toLowerCase()) {
        domain = lark.Domain.Feishu;
      } else if ("lark" === config.domain.toLowerCase()) {
        domain = lark.Domain.Lark;
      } else {
        domain = config.domain;
      }
    }
    this.#sdk = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: domain,
      logger: createLarkLogger("lark-sdk"),
      loggerLevel: getLarkLoggerLevel(),
    })
  }

  async replyText(messageId, text) {
    try {
      this.#logger.withMetadata({ messageId, textLength: text.length }).debug("Replying text");

      const resp = await this.#sdk.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      })
      this.#logger
        .withMetadata({ messageId, replyMessageId: resp.data?.message_id })
        .debug("Reply text sent")
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to reply text")
      return undefined
    }
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @returns {Promise<string|undefined>}
   */
  async sendText(chatId, text) {
    try {
      const resp = await this.#sdk.im.message.create({
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
        params: { receive_id_type: "chat_id" },
      })
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to send text")
      return undefined
    }
  }

  /**
   * @param {string} userOpenId
   * @param {string} text
   * @returns {Promise<string|undefined>}
   */
  async sendTextByUserOpenId(userOpenId, text) {
    try {
      const resp = await this.#sdk.im.message.create({
        data: {
          receive_id: userOpenId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
        params: { receive_id_type: "open_id" },
      })
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to send text")
      return undefined
    }
  }

  async sendCard(chatId, card) {
    try {
      const resp = await this.#sdk.im.message.create({
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
        params: { receive_id_type: "chat_id" },
      })
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to send card")
      return undefined
    }
  }

  async replyCard(messageId, card) {
    try {
      this.#logger.withMetadata({ messageId }).debug("Replying card")
      const resp = await this.#sdk.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      })
      this.#logger
        .withMetadata({ messageId, replyMessageId: resp.data?.message_id })
        .debug("Reply card sent")
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to reply card")
      return undefined
    }
  }

  async replyPost(messageId, post) {
    try {
      this.#logger.withMetadata({ messageId }).debug("Replying post")
      const resp = await this.#sdk.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify(post),
          msg_type: "post",
        },
      })
      this.#logger
        .withMetadata({ messageId, replyMessageId: resp.data?.message_id })
        .debug("Reply post sent")
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to reply post")
      return undefined
    }
  }

  async editMessage(messageId, msgType, content) {
    try {
      this.#logger.withMetadata({ messageId, msgType }).debug("Editing message")
      await this.#sdk.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: msgType, content },
      })
      this.#logger.withMetadata({ messageId }).debug("Message edited")
    } catch (error) {
      this.#logger.withError(error).error("Failed to edit message")
    }
  }

  async updateCard(messageId, card) {
    try {
      this.#logger.withMetadata({ messageId }).debug("Updating card")
      await this.#sdk.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      this.#logger.withMetadata({ messageId }).debug("Card updated")
    } catch (error) {
      this.#logger.withError(error).error("Failed to update card")
    }
  }

  async recallMessage(messageId) {
    try {
      this.#logger.withMetadata({ messageId }).debug("Recalling message")
      await this.#sdk.im.message.delete({
        path: { message_id: messageId },
      })
      this.#logger.withMetadata({ messageId }).debug("Message recalled")
    } catch (error) {
      this.#logger.withError(error).error("Failed to recall message")
    }
  }

  async sendPost(chatId, post) {
    try {
      const resp = await this.#sdk.im.message.create({
        data: {
          receive_id: chatId,
          content: JSON.stringify(post),
          msg_type: "post",
        },
        params: { receive_id_type: "chat_id" },
      })
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to send post")
      return undefined
    }
  }

  async createCardEntity(cardJson) {
    try {
      this.#logger.debug("Creating card entity")
      const resp = await this.#sdk.cardkit.v1.card.create({
        data: { type: "card_json", data: JSON.stringify(cardJson) },
      })
      const cardId = resp.data?.card_id
      this.#logger.withMetadata({ cardId }).debug("Card entity created")
      return cardId
    } catch (error) {
      this.#logger.withError(error).error("Failed to create card entity")
      return undefined
    }
  }

  async replyCardEntity(messageId, cardId) {
    try {
      this.#logger.withMetadata({ messageId, cardId }).debug("Replying with card entity")
      const resp = await this.#sdk.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
          msg_type: "interactive",
        },
      })
      this.#logger
        .withMetadata({ messageId, replyMessageId: resp.data?.message_id })
        .debug("Card entity reply sent")
      return resp.data?.message_id
    } catch (error) {
      this.#logger.withError(error).error("Failed to reply card entity")
      return undefined
    }
  }

  async streamCardText(cardId, elementId, content, sequence) {
    try {
      await this.#sdk.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence },
      })
    } catch (error) {
      this.#logger.withError(error).error("Failed to stream card text")
    }
  }

  async updateCardElement(cardId, elementId, element, sequence) {
    try {
      await this.#sdk.cardkit.v1.cardElement.update({
        path: { card_id: cardId, element_id: elementId },
        data: {
          element: JSON.stringify(element),
          sequence,
        },
      })
    } catch (error) {
      this.#logger.withError(error).error("Failed to update card element")
    }
  }

  async addCardElements(cardId, type, targetElementId, elements, sequence) {
    try {
      await this.#sdk.cardkit.v1.cardElement.create({
        path: { card_id: cardId },
        data: {
          type,
          target_element_id: targetElementId,
          elements: JSON.stringify(elements),
          sequence,
        },
      })
    } catch (error) {
      this.#logger.withError(error).error("Failed to add card elements")
    }
  }

  async deleteCardElement(cardId, elementId, sequence) {
    try {
      await this.#sdk.cardkit.v1.cardElement.delete({
        path: { card_id: cardId, element_id: elementId },
        data: { sequence },
      })
    } catch (error) {
      this.#logger.withError(error).error("Failed to delete card element")
    }
  }

  async updateCardSettings(cardId, settings, sequence) {
    try {
      await this.#sdk.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { settings: JSON.stringify(settings), sequence },
      })
    } catch (error) {
      this.#logger.withError(error).error("Failed to update card settings")
    }
  }

  async replyMarkdownCard(messageId, markdown) {
    return this.replyCard(messageId, buildMarkdownCard(markdown))
  }

  async sendMarkdownCard(chatId, markdown) {
    return this.sendCard(chatId, buildMarkdownCard(markdown))
  }

  async fetchDocContent(docToken) {
    try {
      const resp = await this.#sdk.docx.document.rawContent({
        path: { document_id: docToken },
      })
      return resp.data?.content ?? null
    } catch (error) {
      this.#logger.withError(error).error("Failed to fetch doc content")
      return null
    }
  }

  async appendDocContent(docToken, text) {
    try {
      await this.#sdk.docx.documentBlockChildren.create({
        path: { document_id: docToken, block_id: docToken },
        data: {
          children: [
            {
              block_type: 2,
              text: {
                elements: [{ text_run: { content: text } }],
              },
            },
          ],
        },
        params: { document_revision_id: -1 },
      })
      return true
    } catch (error) {
      this.#logger.withError(error).error("Failed to append doc content")
      return false
    }
  }
}
