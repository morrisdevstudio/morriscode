export class MorrisCodeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MorrisCodeError'
  }
}

export class SessionNotFoundError extends MorrisCodeError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND', { sessionId })
    this.name = 'SessionNotFoundError'
  }
}

export class InvalidPhaseTransitionError extends MorrisCodeError {
  constructor(from: string, to: string) {
    super(`Invalid phase transition: ${from} -> ${to}`, 'INVALID_PHASE_TRANSITION', { from, to })
    this.name = 'InvalidPhaseTransitionError'
  }
}

export class ToolExecutionError extends MorrisCodeError {
  constructor(tool: string, message: string, details?: unknown) {
    super(`Tool '${tool}' failed: ${message}`, 'TOOL_EXECUTION_ERROR', { tool, ...(details as object) })
    this.name = 'ToolExecutionError'
  }
}

export class LLMError extends MorrisCodeError {
  constructor(message: string, details?: unknown) {
    super(message, 'LLM_ERROR', details)
    this.name = 'LLMError'
  }
}

export class ValidationError extends MorrisCodeError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', details)
    this.name = 'ValidationError'
  }
}

export class WorkspaceInUseError extends MorrisCodeError {
  constructor(
    message: string,
    public readonly conflictingSessionIds: string[],
  ) {
    super(message, 'WORKSPACE_IN_USE')
    this.name = 'WorkspaceInUseError'
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof MorrisCodeError) {
    return ['LLM_ERROR', 'TOOL_EXECUTION_ERROR'].includes(error.code)
  }
  return false
}
