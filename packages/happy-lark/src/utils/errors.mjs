/**
 * @param {unknown} value
 * @returns {value is { message: string }}
 */
function hasMessage(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  )
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function extractErrorMessage(error) {
  if (error instanceof Error) {
    return error.message
  }
  if (hasMessage(error)) {
    return error.message
  }
  return String(error)
}

/**
 * @property {string} code
 */
export class LarkCoderError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message)
    this.name = "LarkCoderError"
    this.code = code
  }
}

/**
 * @extends {LarkCoderError}
 */
export class SessionNotFoundError extends LarkCoderError {
  /**
   * @param {string} identifier
   */
  constructor(identifier) {
    super(`Session not found: ${identifier}`, "SESSION_NOT_FOUND")
    this.name = "SessionNotFoundError"
  }
}

/**
 * @extends {LarkCoderError}
 */
export class SessionStateError extends LarkCoderError {
  /**
   * @param {string} sessionId
   * @param {string} currentStatus
   * @param {string} action
   */
  constructor(sessionId, currentStatus, action) {
    super(`Cannot ${action} session ${sessionId} in status ${currentStatus}`, "SESSION_STATE_ERROR")
    this.name = "SessionStateError"
  }
}

/**
 * @extends {LarkCoderError}
 */
export class ProjectNotFoundError extends LarkCoderError {
  /**
   * @param {string} identifier
   */
  constructor(identifier) {
    super(`Project not found: ${identifier}`, "PROJECT_NOT_FOUND")
    this.name = "ProjectNotFoundError"
  }
}
