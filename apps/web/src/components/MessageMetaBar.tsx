import Icon from './Icon'
import { useState } from 'react'
import ProcessTrace from './ProcessTrace'
import {
  type DateTimeValue,
  formatConversationDateTime,
  formatDurationBetween,
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

function hasIdleTimeoutEvent(events?: any[]): boolean {
  return (events || []).some((event) => (
    event?.type === 'status' && event?.data?.status === 'idle_timeout'
  ))
}

function hasTurnDoneEvent(events?: any[]): boolean {
  return (events || []).some((event) => (
    event?.type === 'status' && event?.data?.status === 'done'
  ))
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
  /** Render this message as a manual review header (no engine process trace). */
  reviewMode?: boolean
  /** Manual review outcome used to color the badge (passed=green, others=red). */
  reviewStatus?: string
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
  reviewMode = false,
  reviewStatus,
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

  return reviewMode ? (
    <div style={{
      width: '100%', minHeight: 30,
      padding: '6px 0',
      color: 'var(--meta)', fontSize: 11,
      borderBottom: '1px solid var(--border-soft)',
      display: 'flex', alignItems: 'center', gap: 8,
      fontVariantNumeric: 'tabular-nums',
    }}>
      {!running && endedAt && (
        <span style={{ color: 'var(--meta)', fontSize: 11, flexShrink: 0 }}>
          {t('taskDetail.reviewDuration', {
            duration: formatDurationBetween(displayStartedAt, endedAt, t) || '',
          })}
        </span>
      )}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 18, padding: '0 7px', borderRadius: 9,
        background: reviewStatus === 'passed'
          ? 'rgba(46,160,67,0.08)'
          : 'rgba(217,45,32,0.08)',
        color: reviewStatus === 'passed' ? 'var(--success)' : 'var(--danger)',
        fontSize: 11, flexShrink: 0,
        whiteSpace: 'nowrap',
      }}>
        <Icon name={reviewStatus === 'passed' ? 'check' : 'x'} size={11} strokeWidth={2.2} />
        {t('taskDetail.manualReview')}
      </span>
      <span
        title={formatConversationDateTime(displayStartedAt, Date.now(), locale)}
        style={{ marginLeft: 'auto', minHeight: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}
      >
        {formatConversationDateTime(displayStartedAt, Date.now(), locale)}
      </span>
    </div>
  ) : (
    <div style={{
      width: '100%', minHeight: 30,
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
        summaryMeta={(
          <span
            className="message-meta-details"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            style={{
              marginLeft: 'auto', minWidth: 0,
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
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
            {hasIdleTimeoutEvent(events) && (
              <span
                title={t('meta.idleTimeoutTitle')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  height: 18, padding: '0 7px', borderRadius: 9,
                  background: 'color-mix(in oklab, var(--warn), transparent 86%)',
                  color: 'var(--warn-text)', fontSize: 11, flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="clock" size={11} strokeWidth={2.2} />
                {t('meta.idleTimeout')}
              </span>
            )}
            {running && hasTurnDoneEvent(events) && !hasIdleTimeoutEvent(events) && (
              <span
                title={t('meta.waitingInjectionTitle')}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  height: 18, padding: '0 7px', borderRadius: 9,
                  background: 'color-mix(in oklab, var(--accent), transparent 88%)',
                  color: 'var(--accent)', fontSize: 11, flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <Icon name="clock" size={11} strokeWidth={2.2} />
                {t('meta.waitingInjection')}
              </span>
            )}
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
          </span>
        )}
      />
    </div>
  )
}
