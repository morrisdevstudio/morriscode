let restartHandler: (() => void) | null = null

export function setRestartHandler(handler: (() => void) | null): void {
  restartHandler = handler
}

/** Ask the host process to shut down cleanly so the launcher can start the new release. */
export function requestRestart(delayMs = 250): boolean {
  if (!restartHandler) return false
  const handler = restartHandler
  const timer = setTimeout(handler, delayMs)
  timer.unref?.()
  return true
}
