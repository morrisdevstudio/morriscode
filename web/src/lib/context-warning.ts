/**
 * Models whose context window is below this threshold cannot fit MorrisCode's
 * base prompt (system prompt + tools + agent reminder, roughly 8-12k tokens)
 * plus any history, so the provider silently truncates and drops the user's
 * message. Warn the user so they can raise the value in the edit-model modal.
 */
export const MIN_CONTEXT_WARNING = 16384

export function isSmallContext(contextWindow: number): boolean {
  return contextWindow < MIN_CONTEXT_WARNING
}
