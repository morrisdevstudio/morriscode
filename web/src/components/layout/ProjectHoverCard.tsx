import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../hooks/useT'
import { CheckIcon, CopyIcon, FolderIcon, GearIcon, MessagesIcon, StarFilledIcon, StarIcon } from '../shared/icons'

export interface ProjectHoverCardProject {
  id: string
  name: string
  workdir: string
  isStarred?: boolean
  sessionCount?: number
}

interface ProjectHoverCardProps {
  project: ProjectHoverCardProject
  anchorRect: DOMRect
  unreadCount: number
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClose: () => void
  onToggleStar: (isStarred: boolean) => void
  onEdit?: () => void
}

const CARD_WIDTH = 320
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 8

export function ProjectHoverCard({
  project,
  anchorRect,
  unreadCount,
  onMouseEnter,
  onMouseLeave,
  onClose,
  onToggleStar,
  onEdit,
}: ProjectHoverCardProps) {
  const t = useT()
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return

    const updatePosition = () => {
      const width = card.offsetWidth || CARD_WIDTH
      const height = card.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let left = anchorRect.right + ANCHOR_GAP
      if (left + width + VIEWPORT_MARGIN > viewportWidth) {
        left = anchorRect.left - width - ANCHOR_GAP
      }
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - width - VIEWPORT_MARGIN))

      const top = Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.top, viewportHeight - height - VIEWPORT_MARGIN))
      setPosition({ top, left })
    }

    updatePosition()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updatePosition)
    observer.observe(card)
    return () => observer.disconnect()
  }, [anchorRect])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const discussionCount = project.sessionCount ?? 0

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(project.workdir)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t(
        { en: 'Project information for {{name}}', fr: 'Informations du projet {{name}}' },
        { name: project.name },
      )}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width: CARD_WIDTH,
        visibility: position ? 'visible' : 'hidden',
      }}
      className="fixed z-[70] max-w-[calc(100vw-16px)] rounded-lg border border-border bg-bg-secondary p-3 shadow-xl"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-2">
        <FolderIcon className="w-4 h-4 shrink-0 text-text-secondary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{project.name}</span>
        <button
          type="button"
          onClick={() => onToggleStar(!project.isStarred)}
          aria-pressed={!!project.isStarred}
          aria-label={
            project.isStarred
              ? t(
                  { en: 'Unfavorite project {{name}}', fr: 'Retirer le projet {{name}} des favoris' },
                  { name: project.name },
                )
              : t(
                  { en: 'Favorite project {{name}}', fr: 'Ajouter le projet {{name}} aux favoris' },
                  { name: project.name },
                )
          }
          title={
            project.isStarred
              ? t({ en: 'Unfavorite project', fr: 'Retirer le projet des favoris' })
              : t({ en: 'Favorite project', fr: 'Ajouter le projet aux favoris' })
          }
          className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          {project.isStarred ? <StarFilledIcon className="w-4 h-4 text-amber-400" /> : <StarIcon className="w-4 h-4" />}
        </button>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary">
        <MessagesIcon className="w-3.5 h-3.5 shrink-0 text-text-muted" />
        <span>
          {t(
            {
              en: { one: '{{count}} discussion', other: '{{count}} discussions' },
              fr: { one: '{{count}} discussion', other: '{{count}} discussions' },
            },
            { count: discussionCount },
          )}
        </span>
        {unreadCount > 0 && (
          <>
            <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-text-muted/60" />
            <span className="text-amber-400">
              {t(
                {
                  en: { one: '{{count}} unread', other: '{{count}} unread' },
                  fr: { one: '{{count}} non lu', other: '{{count}} non lus' },
                },
                { count: unreadCount },
              )}
            </span>
          </>
        )}
      </div>

      <div className="mt-2 flex items-start gap-1.5 text-xs text-text-muted">
        <FolderIcon className="mt-0.5 w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0 flex-1 break-all leading-snug" title={project.workdir}>
          {project.workdir}
        </span>
        <button
          type="button"
          onClick={() => void handleCopyPath()}
          aria-label={t({ en: 'Copy project path', fr: 'Copier le chemin du projet' })}
          title={copied ? t({ en: 'Path copied', fr: 'Chemin copié' }) : t({ en: 'Copy path', fr: 'Copier le chemin' })}
          className="-m-1 shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          {copied ? <CheckIcon className="w-3.5 h-3.5 text-amber-400" /> : <CopyIcon className="w-3.5 h-3.5" />}
        </button>
      </div>

      {onEdit && (
        <>
          <div className="my-2.5 border-t border-border" />
          <button
            type="button"
            onClick={onEdit}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-sm text-text-primary transition-colors hover:bg-bg-tertiary"
          >
            <GearIcon className="w-4 h-4 text-text-secondary" />
            {t({ en: 'Edit project', fr: 'Modifier le projet' })}
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
