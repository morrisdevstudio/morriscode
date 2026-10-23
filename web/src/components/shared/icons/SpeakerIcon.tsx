interface SpeakerIconProps {
  className?: string
  muted?: boolean
}

export function SpeakerIcon({ className = 'w-4 h-4', muted = false }: SpeakerIconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
      {muted ? (
        <path strokeLinecap="round" d="m16 9 5 6m0-6-5 6" />
      ) : (
        <path strokeLinecap="round" d="M15 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />
      )}
    </svg>
  )
}
