import Icon from './Icon'
import { useState } from 'react'
import ProcessTrace from './ProcessTrace'
import {
  type DateTimeValue,
  formatConversationDateTime,
  formatExecutionClock,
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
          title="该条 LLM 消息执行失败"
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
          失败
        </span>
      ) : null}
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
          <Icon name="undo-2" size={11} strokeWidth={2.2} />
          上下文已压缩
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
            className="meta-link-btn chat-message-action"
            title="查看发送给 LLM 的完整提示词"
            onClick={() => onViewPrompt(prompt)}
            style={{
              fontSize: 11, color: 'var(--accent)',
              display: 'inline-flex', alignItems: 'center',
              minHeight: 24, flexShrink: 0,
            }}
          >
            查看提示词
          </button>
        )}
        <span
          title={origin ? formatConversationDateTime(displayStartedAt) : undefined}
          style={{ width: 112, minHeight: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
        >
          {origin
            ? formatExecutionClock(displayStartedAt)
            : formatConversationDateTime(displayStartedAt)}
        </span>
      </div>
    </div>
  )
}
