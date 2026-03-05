import { LoggerLevel } from "@larksuiteoapi/node-sdk"
import { createLogger, getLogLevel } from "../utils/logger.mjs"

const loggerLevelMap = {
  trace: LoggerLevel.trace,
  debug: LoggerLevel.debug,
  info: LoggerLevel.info,
  warn: LoggerLevel.warn,
  error: LoggerLevel.error,
  fatal: LoggerLevel.error,
}

export function getLarkLoggerLevel() {
  return loggerLevelMap[getLogLevel()]
}

function formatArg(arg) {
  if (typeof arg === "string") {
    return arg
  }
  if (arg instanceof Error) {
    return arg.stack ?? arg.message
  }
  if (typeof arg === "object" && arg !== null) {
    return Bun.inspect(arg)
  }
  return String(arg)
}

function formatMsg(msg) {
  return msg
    .flatMap((arg) => (Array.isArray(arg) ? arg : [arg]))
    .map(formatArg)
    .join(" ")
}

export function createLarkLogger(prefix) {
  const l = createLogger({ prefix })
  return {
    error: (...msg) => l.error(formatMsg(msg)),
    warn: (...msg) => l.warn(formatMsg(msg)),
    info: (...msg) => l.info(formatMsg(msg)),
    debug: (...msg) => l.debug(formatMsg(msg)),
    trace: (...msg) => l.trace(formatMsg(msg)),
  }
}
