import Icon from './Icon'
import { useState } from 'react'
import ProcessTrace from './ProcessTrace'
import {
  type DateTimeValue,
  formatConversationDateTime,
  formatExecutionClock,
  toMilliseconds,
} from '../utils/datetime'
import { useI18n } from '../i18n'

/* ══════════════════════════════════════════
   MessageMetaBar — shared LLM message meta row
   (timestamp + process trace + session id + prompt
   viewer link). Used by the task conversation and the
   AI flow-design chat so both render the same header.
   ══════════════════════════════════════════ */

function hasCompactedEvent(events?: any[]): boolean {
  return (events || []).some((event) => event?.type === 'compacted')
}

export interface MessageMetaBarProps {
  createdAt?: string | number | null
  startedAt?: string | number | null
  endedAt?: string | number | null
  running?: boolean
  events?: any[]
  prompt?: string | null
  sessionId?: string | null
  onViewPrompt: (prompt: string) => void
  origin?: DateTimeValue
  /** Terminal message status shown as a pill (cancelled/stopped/failed). */
  status?: 'cancelled' | 'stopped' | 'failed'
}

export default function MessageMetaBar({
  createdAt,
  startedAt,
  endedAt,
  running = false,
  events,
  prompt,
  sessionId,
  onViewPrompt,
  origin,
  status,
}: MessageMetaBarProps) {
  const { t, locale } = useI18n()
  const [sessionCopied, setSessionCopied] = useState(false)
  const eventStartedAt = (events || []).reduce<number | null>((earliest, event) => {
    const timestamp = toMilliseconds(event?.created_at ?? event?.timestamp)
    if (timestamp === null) return earliest
    return earliest === null ? timestamp : Math.min(earliest, timestamp)
  }, null)
  const displayStartedAt = startedAt || createdAt || eventStartedAt
  const eventSessionId = (events || []).reduce<string | null>((found, event) => {
    if (found) return found
    const sid = event?.data?.session_id
    return typeof sid === 'string' && sid.trim() ? sid : null
  }, null)
  const displaySessionId = sessionId || eventSessionId
  const copySessionId = async () => {
    if (!displaySessionId) return
    try {
      await navigator.clipboard.writeText(displaySessionId)
      setSessionCopied(true)
      setTimeout(() => setSessionCopied(false), 1500)
    } catch {
      // Clipboard unavailable — leave state untouched.
    }
  }

  return (
    <div style={{
      width: '100%', minHeight: 30,
      display: 'flex', alignItems: 'flex-start', gap: 12,
      paddingBottom: 6,
      color: 'var(--meta)', fontSize: 11,
      borderBottom: '1px solid var(--border-soft)',
    }}>
      <ProcessTrace
        events={events || []}
        running={running}
        stopped={status === 'cancelled' || status === 'stopped'}
        startedAt={displayStartedAt}
        endedAt={endedAt}
        compact
      />
      {status === 'failed' ? (
        <span
          title={t('meta.failedTitle')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            height: 18, padding: '0 7px', borderRadius: 9,
            border: '1px solid rgba(217,45,32,0.45)',
            background: 'rgba(217,45,32,0.08)',
            color: 'var(--danger)', fontSize: 11, flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="x" size={8} strokeWidth={2.6} />
          {t('trace.failed')}
        </span>
      ) : null}
      {hasCompactedEvent(events) && (
        <span
          title={t('meta.compactedTitle')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            height: 18, padding: '0 7px', borderRadius: 9,
            background: 'color-mix(in oklab, var(--meta), transparent 88%)',
            color: 'var(--meta)', fontSize: 11, flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="undo-2" size={11} strokeWidth={2.2} />
          {t('meta.compacted')}
        </span>
      )}
      <div style={{
        marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
        minWidth: 0, flexShrink: 0,
      }}>
        {displaySessionId && (
          <button
            type="button"
            className="chat-message-action"
            title={sessionCopied
              ? t('common.copied')
              : t('meta.copySessionTitle', { sessionId: displaySessionId })}
            aria-label={t('meta.copySessionAria')}
            onClick={() => void copySessionId()}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 11,
              color: sessionCopied ? 'var(--success)' : 'var(--meta)',
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            }}
          >
            {sessionCopied ? t('common.copied') : displaySessionId}
          </button>
        )}
        {prompt && (
          <button
            type="button"
            className="meta-link-btn chat-message-action"
            title={t('meta.viewPromptTitle')}
            onClick={() => onViewPrompt(prompt)}
            style={{
              fontSize: 11, color: 'var(--accent)',
              display: 'inline-flex', alignItems: 'center',
              minHeight: 24, flexShrink: 0,
            }}
          >
            {t('meta.viewPrompt')}
          </button>
        )}
        <span
          title={origin ? formatConversationDateTime(displayStartedAt, Date.now(), locale) : undefined}
          style={{ width: 112, minHeight: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
        >
          {origin
            ? formatExecutionClock(displayStartedAt)
            : formatConversationDateTime(displayStartedAt, Date.now(), locale)}
        </span>
      </div>
    </div>
  )
}
