import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { ChatSessionSummary } from '../api/client'
import { useI18n } from '../i18n'
import { formatConversationDateTime, formatRelativeTime } from '../utils/datetime'
import Button from './Button'
import Icon from './Icon'

type Session = Pick<ChatSessionSummary, 'id' | 'title' | 'created_at' | 'updated_at'>

export default function SessionRowActions({ session, hovered, now, onArchive, onMore }: {
  session: Session
  hovered: boolean
  now: number
  onArchive: () => void
  onMore: (event: MouseEvent) => void
}) {
  const { t, locale } = useI18n()
  const [revealed, setRevealed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const timestamp = session.updated_at || session.created_at

  useEffect(() => {
    if (!revealed) return
    const close = (event: globalThis.MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setRevealed(false)
    }
    document.addEventListener('click', close, true)
    return () => document.removeEventListener('click', close, true)
  }, [revealed])

  return <div ref={root} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, height: 24 }}>
    {(hovered || revealed) && <Button
      variant="icon"
      className="ws-more-btn"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onArchive() }}
      title={t('chatSession.archive')}
      aria-label={t('chatSession.archive')}
      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--meta)', padding: 0, flexShrink: 0, opacity: revealed ? 1 : undefined, pointerEvents: revealed ? 'auto' : undefined }}
    ><Icon name="archive" size={13} /></Button>}
    {hovered || !timestamp ? <Button
      variant="icon"
      className="ws-more-btn"
      onPointerDown={event => event.stopPropagation()}
      onClick={onMore}
      title={t('layout.moreActions')}
      aria-label={t('layout.moreActions')}
      style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: '22px', padding: 0, flexShrink: 0 }}
    >⋯</Button> : revealed ? null : <button
      type="button"
      title={formatConversationDateTime(timestamp, now, locale)}
      aria-label={formatConversationDateTime(timestamp, now, locale)}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
      onClick={event => { event.stopPropagation(); setRevealed(true) }}
      className="ws-session-time-button"
      style={{
        flexShrink: 0, whiteSpace: 'nowrap', padding: '0 6px',
        display: 'inline-flex', alignItems: 'center', height: '100%',
        border: 0, background: 'transparent', cursor: 'pointer',
        fontSize: 'calc(10.5px * var(--font-scale))', color: 'var(--meta)', opacity: 0.8,
      }}
    ><time dateTime={timestamp}>{formatRelativeTime(timestamp, now, t)}</time></button>}
  </div>
}
