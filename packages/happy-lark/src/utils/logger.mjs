import { getSimplePrettyTerminal } from "@loglayer/transport-simple-pretty-terminal"
import { LogLayer } from "loglayer"
import { serializeError } from "serialize-error"

/**
 * @typedef {"trace" | "debug" | "info" | "warn" | "error" | "fatal"} LogLevel
 */

/** @type {readonly ["trace", "debug", "info", "warn", "error", "fatal"]} */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"]
// export { LogLevel }

/**
 * @typedef {Object} LoggerOptions
 * @property {string} [prefix]
 */

function defaultLogLevel() {
  return process.env.NODE_ENV === "production" ? "info" : "trace"
}

function buildLogger(level) {
  return new LogLayer({
    errorSerializer: serializeError,
    transport: getSimplePrettyTerminal({
      runtime: "node",
      level,
    }),
  })
}

/** @type {LogLevel} */
let currentLevel = defaultLogLevel()
/** @type {LogLayer} */
let logger = buildLogger(currentLevel)

/**
 * @param {LogLevel} level
 */
export function setLogLevel(level) {
  currentLevel = level
  logger = buildLogger(currentLevel)
}

export function getLogLevel() {
  return currentLevel
}

/**
 * @param {LoggerOptions} [options]
 * @returns {LogLayer}
 */
export function createLogger(options) {
  const prefix = options?.prefix

  let newLogger = logger.child()
  if (prefix) {
    newLogger = newLogger.withPrefix(`[${prefix}]`)
  }
  return newLogger
}
