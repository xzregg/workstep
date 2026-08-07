import { useState } from 'react'
import type { ReactNode } from 'react'
import ProcessTrace from './ProcessTrace'
import {
  type DateTimeValue,
  formatConversationDateTime,
  formatExecutionOffset,
  toMilliseconds,
} from '../utils/datetime'

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
  /** Extra controls rendered at the end of the meta row (e.g. stop button). */
  actions?: ReactNode
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
  actions,
}: MessageMetaBarProps) {
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
      paddingBottom: 6, borderBottom: '1px solid var(--border-soft)',
      color: 'var(--meta)', fontSize: 11, flexWrap: 'wrap',
    }}>
      <span
        title={origin ? formatConversationDateTime(displayStartedAt) : undefined}
        style={{ width: 112, minHeight: 24, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
      >
        {origin ? formatExecutionOffset(displayStartedAt, origin) : formatConversationDateTime(displayStartedAt)}
      </span>
      <ProcessTrace
        events={events || []}
        running={running}
        startedAt={displayStartedAt}
        endedAt={endedAt}
        compact
      />
      {hasCompactedEvent(events) && (
        <span
          title="上下文接近上限时引擎已自动压缩，保留摘要继续对话"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            height: 18, padding: '0 7px', borderRadius: 9,
            background: 'color-mix(in oklab, var(--meta), transparent 88%)',
            color: 'var(--meta)', fontSize: 11, flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M4 8h11a5 5 0 0 1 0 10H4" />
            <path d="m7 5-3 3 3 3" />
          </svg>
          上下文已压缩
        </span>
      )}
      {(displaySessionId || prompt || actions) && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {displaySessionId && (
            <button
              type="button"
              title={sessionCopied
                ? '已复制'
                : `点击复制该阶段 LLM 引擎会话 ID：${displaySessionId}`}
              aria-label="复制会话 ID"
              onClick={() => void copySessionId()}
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: sessionCopied ? 'var(--success)' : 'var(--meta)',
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              }}
            >
              {sessionCopied ? '已复制' : displaySessionId}
            </button>
          )}
          {prompt && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onViewPrompt(prompt)}
              style={{ padding: 0, minHeight: 24, color: 'var(--accent)', fontSize: 11, alignItems: 'center', flexShrink: 0 }}
            >
              查看提示词
            </button>
          )}
          {actions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {actions}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
