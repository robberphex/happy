/**
 * @typedef {Object} LarkConfig
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} [docToken]
 */

/**
 * @typedef {Object} ParsedMessage
 * @property {string} messageId
 * @property {string} chatId
 * @property {"p2p" | "group"} chatType
 * @property {string} senderId
 * @property {string} [rootId]
 * @property {string} text
 */

/**
 * @typedef {Object} CardAction
 * @property {string} openId
 * @property {string} openMessageId
 * @property {string} openChatId
 * @property {string} action
 * @property {string} [sessionId]
 * @property {string} [optionId]
 * @property {string} [modelId]
 * @property {string} [modeId]
 * @property {string} [configId]
 * @property {string} [configValue]
 * @property {string} [projectId]
 * @property {string} [commandName]
 * @property {Record<string, string>} [formValue]
 */

export { }
