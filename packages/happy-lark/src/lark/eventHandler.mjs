import * as Lark from "@larksuiteoapi/node-sdk"
import { createLarkLogger, getLarkLoggerLevel } from "./logger.mjs"

export const MessageHandler = (message) => Promise.resolve()
export const CardActionHandler = (action) => Promise.resolve()

export class LarkEventHandler {
  constructor(logger) {
    this.logger = logger
  }

  onMessage(handler) {
    this.messageHandler = handler
  }

  onCardAction(handler) {
    this.cardActionHandler = handler
  }

  createEventDispatcher(sessionService) {
    return new Lark.EventDispatcher({
      logger: createLarkLogger("lark-event"),
      loggerLevel: getLarkLoggerLevel(),
    }).register({
      "im.message.receive_v1": async (data) => {
        const eventId = data.event_id

        if (eventId) {
          if (await sessionService.isEventProcessed(eventId)) {
            this.logger.info(`Duplicate event: ${eventId}`)
            return
          }
          await sessionService.markEventProcessed(eventId)
        }

        const message = this.parseIMMessage(data)
        if (message) {
          this.logger
            .withMetadata({
              messageId: message.messageId,
              chatId: message.chatId,
              chatType: message.chatType,
              senderId: message.senderId,
              threadId: message.rootId,
            })
            .info("Received message")

          this.logger
            .withMetadata({ messageId: message.messageId, textLength: message.text.length })
            .debug("Message content")

          if (this.messageHandler) {
            this.messageHandler(message).catch((err) => {
              this.logger.withError(err).error("Message handler error")
            })
          }
        }
      },

      "card.action.trigger": async (data) => {
        const action = this.parseCardAction(data)
        if (action) {
          this.logger
            .withMetadata({
              action: action.action,
              sessionId: action.sessionId,
              openId: action.openId,
            })
            .info("Received card action")

          if (this.cardActionHandler) {
            this.cardActionHandler(action).catch((err) => {
              this.logger.withError(err).error("Card action handler error")
            })
          }
        }
        return {}
      },
    })
  }

  parseIMMessage(data) {
    const { sender, message } = data

    if (message.message_type !== "text") {
      this.logger.info(`Ignoring non-text message: ${message.message_type}`)
      return null
    }

    const chatType = message.chat_type
    let text = ""

    try {
      const content = JSON.parse(message.content)
      text = content.text ?? ""
    } catch {
      this.logger.warn("Failed to parse message content")
      return null
    }

    if (chatType === "group") {
      const mentions = message.mentions
      if (!mentions || mentions.length === 0) {
        return null
      }
      text = text.replace(/@_user_\d+/g, "").trim()
    }

    if (!text) {
      return null
    }

    return {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType,
      senderId: sender.sender_id?.open_id ?? "",
      rootId: message.root_id || undefined,
      text,
    }
  }

  parseCardAction(data) {
    const value = data.action?.value
    const formValue = data.action?.form_value

    if (!value || !value.action) {
      return null
    }

    return {
      openId: data.operator?.open_id ?? "",
      openMessageId: data.context?.open_message_id ?? "",
      openChatId: data.context?.open_chat_id ?? "",
      action: value.action,
      sessionId: value.session_id,
      optionId: value.option_id,
      modelId: value.model_id,
      modeId: value.mode_id,
      configId: value.config_id,
      configValue: value.config_value,
      projectId: value.project_id,
      commandName: value.command_name,
      formValue: formValue ?? undefined,
    }
  }
}
