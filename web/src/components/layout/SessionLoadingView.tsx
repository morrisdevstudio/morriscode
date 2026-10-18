import { useT } from '../../hooks/useT'

/** Keeps the conversation surface visible while the target session is fetched. */
export function SessionLoadingView() {
  const t = useT()
  return (
    <div className="absolute inset-0 flex flex-col bg-primary p-4" role="status" aria-live="polite">
      <span className="sr-only">{t({ en: 'Loading conversation…', fr: 'Chargement de la conversation…' })}</span>
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6" aria-hidden="true">
        <div className="h-8 border-b border-border" />
        <div className="ml-auto w-2/3 rounded-lg bg-bg-tertiary/50 p-4 space-y-2">
          <div className="h-3 w-5/6 rounded bg-bg-tertiary" />
          <div className="h-3 w-2/3 rounded bg-bg-tertiary" />
        </div>
        <div className="w-3/4 space-y-3">
          <div className="h-3 w-full rounded bg-bg-tertiary/50" />
          <div className="h-3 w-5/6 rounded bg-bg-tertiary/50" />
          <div className="h-3 w-2/3 rounded bg-bg-tertiary/50" />
        </div>
        <div className="mt-auto h-20 shrink-0 rounded-lg border border-border bg-secondary" />
      </div>
    </div>
  )
}
