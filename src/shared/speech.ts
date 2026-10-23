export type SpeechLanguage = 'fr' | 'en'

export type SpeechInstallStage =
  | 'idle'
  | 'preparing'
  | 'creating-environment'
  | 'installing-engine'
  | 'downloading-model'
  | 'downloading-voices'
  | 'verifying'

export interface SpeechStatus {
  state: 'ready' | 'not-installed' | 'installing' | 'error'
  installed: boolean
  stage: SpeechInstallStage
  progress: number
  cpuOnly: true
  voice: 'ff_siwis'
  error?: string
}

export interface SpeechPreparation {
  chunks: string[]
  characterCount: number
}

// A short first chunk keeps the initial wait reasonable on a CPU-only engine.
const MAX_CHUNK_CHARACTERS = 180

function normalizeMarkdownForSpeech(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const readable: string[] = []
  let fence: { marker: '`' | '~'; length: number } | null = null

  for (const rawLine of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine)
    if (fence) {
      if (fenceMatch && fenceMatch[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length }
      continue
    }

    let line = rawLine.trim()
    if (!line || /^([-*_])(?:\s*\1){2,}$/.test(line)) continue
    if (/^\s*(?:\|?\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue

    line = line
      .replace(/^>\s?/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/^\|/, '')
      .replace(/\|$/, '')

    if (line.includes('|')) line = line.replace(/\s*\|\s*/g, ', ')
    if (line) readable.push(line)
  }

  return readable
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\\([\\*_{}[\]()#+.!-])/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|\s)[*_](?=\S)(.+?\S)[*_](?=$|\s|[.,;:!?])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function splitLongFragment(fragment: string): string[] {
  if (fragment.length <= MAX_CHUNK_CHARACTERS) return [fragment]

  const chunks: string[] = []
  let remaining = fragment
  while (remaining.length > MAX_CHUNK_CHARACTERS) {
    const window = remaining.slice(0, MAX_CHUNK_CHARACTERS + 1)
    const breakAt = Math.max(window.lastIndexOf(' '), window.lastIndexOf(', '), window.lastIndexOf('; '))
    const index = breakAt > MAX_CHUNK_CHARACTERS / 2 ? breakAt : MAX_CHUNK_CHARACTERS
    chunks.push(remaining.slice(0, index).trim())
    remaining = remaining.slice(index).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/**
 * Turn assistant Markdown into short, speech-friendly chunks. Fenced code,
 * URLs and tool-rendered blocks never reach speech synthesis; headings, list
 * text, table cells and link labels remain audible.
 */
export function prepareSpeechText(content: string): SpeechPreparation {
  const normalized = normalizeMarkdownForSpeech(content)
  if (!normalized) return { chunks: [], characterCount: 0 }

  const fragments = normalized
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .flatMap(splitLongFragment)

  const chunks: string[] = []
  let pending = ''
  for (const fragment of fragments) {
    const candidate = pending ? pending + ' ' + fragment : fragment
    if (candidate.length <= MAX_CHUNK_CHARACTERS) {
      pending = candidate
      continue
    }
    if (pending) chunks.push(pending)
    pending = fragment
  }
  if (pending) chunks.push(pending)

  return {
    chunks,
    characterCount: chunks.reduce((total, chunk) => total + chunk.length, 0),
  }
}

export function prepareSpeechMessage(content: string, textSegments: string[] = []): SpeechPreparation {
  const source = textSegments.some((segment) => segment.trim()) ? textSegments.join('\n\n') : content
  return prepareSpeechText(source)
}
