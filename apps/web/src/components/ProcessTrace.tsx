import { useEffect, useState, type ReactNode } from 'react'
import { MessageCopyButton } from './MessageResponseFooter'
import SubagentTimelineItem from './SubagentTimelineItem'
import ToolTimelineItem from './ToolTimelineItem'
import {
  durationMilliseconds,
  formatDuration,
  toMilliseconds,
  type DateTimeValue,
} from '../utils/datetime'
import { useI18n } from '../i18n'
import {
  buildMessageTimeline,
  characterCount,
  type MessageTimelineItem,
} from '../utils/messageTimeline'

type ProcessEvent = {
  type: string
  data?: Record<string, unknown>
  timestamp?: DateTimeValue
}

interface ProcessTraceProps {
  events: ProcessEvent[]
  running?: boolean
  /** 该条 LLM 消息被手动停止（summary 显示“在 X 后停止了”）。 */
  stopped?: boolean
  startedAt?: DateTimeValue
  endedAt?: DateTimeValue
  compact?: boolean
  summaryMeta?: ReactNode
}

function ThinkingTimelineItem({ content, active }: { content: string; active: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(active)
  useEffect(() => {
    setOpen(active)
  }, [active])

  return (
    <details
      className="process-trace-thinking-block"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="process-trace-section-title">
        <span className="process-trace-summary-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              d="M12 2a7 7 0 0 0-4.6 12.3c.6.5 1 1.2 1.1 2l.2 1.2c.1.6.6 1 1.2 1h4.2c.6 0 1.1-.4 1.2-1l.2-1.2c.1-.8.5-1.5 1.1-2A7 7 0 0 0 12 2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 21h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className={active ? 'process-trace-thinking-label is-shimmer' : 'process-trace-thinking-label'}>
          {active
            ? t('trace.thinking')
            : t('trace.thoughtCharacters', { count: characterCount(content) })}
        </span>
        <svg className="process-trace-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path
            d="m19.5 8.25-7.5 7.5-7.5-7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span
          className="process-trace-thinking-copy"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MessageCopyButton content={content} title={t('trace.copyThinking')} />
        </span>
      </summary>
      <div className="process-trace-thinking">{content}</div>
    </details>
  )
}

export default function ProcessTrace({
  events,
  running = false,
  stopped = false,
  startedAt,
  endedAt,
  compact = false,
  summaryMeta,
}: ProcessTraceProps) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(running)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  useEffect(() => {
    setOpen(running)
  }, [running])

  const processItems = buildMessageTimeline(events).filter(
    (item): item is Exclude<MessageTimelineItem, { type: 'text' }> => item.type !== 'text',
  )
  const lastProcessItem = processItems[processItems.length - 1]
  const commandCount = events.filter((event) => event.type === 'tool_use').length
  const eventTimes = events
    .map((event) => toMilliseconds(event.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== null)
  const startTime = toMilliseconds(startedAt)
    ?? (eventTimes.length ? Math.min(...eventTimes) : null)
  const endTime = running
    ? now
    : toMilliseconds(endedAt)
      ?? (eventTimes.length ? Math.max(...eventTimes) : null)
  const elapsedMs = durationMilliseconds(startTime, endTime)
  const duration = elapsedMs === null ? '' : formatDuration(elapsedMs, t)

  if (!duration && processItems.length === 0 && !summaryMeta) return null

  return (
    <div className={`process-trace${compact ? ' process-trace-compact' : ''}`}>
      <details
        className="process-trace-session"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span>
            {running ? t('trace.processing') : stopped ? '' : t('trace.processed')}
            {!running && stopped
              ? (duration ? t('trace.stoppedAfter', { duration }) : t('trace.stopped'))
              : (duration ? ` ${duration}` : '')}
            {commandCount > 0 && t('trace.commandCount', { count: commandCount })}
          </span>
          <svg className="process-trace-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path
              d="m19.5 8.25-7.5 7.5-7.5-7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {summaryMeta}
        </summary>
        <div className="process-trace-body">
          {processItems.map((item) => item.type === 'thinking' ? (
            <ThinkingTimelineItem
              key={item.id}
              content={item.content}
              active={running && item === lastProcessItem}
            />
          ) : item.type === 'subagent' ? (
            <SubagentTimelineItem key={item.id} item={item} messageRunning={running} />
          ) : (
            <ToolTimelineItem key={item.id} item={item} streaming={running} />
          ))}
        </div>
      </details>
    </div>
  )
}
