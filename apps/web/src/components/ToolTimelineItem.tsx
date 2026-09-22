import Icon from './Icon'
import ToolCallRow from './ToolCallRow'
import { useI18n, type TFunction } from '../i18n'
import { durationMilliseconds, formatDuration } from '../utils/datetime'
import type { MessageTimelineItem } from '../utils/messageTimeline'

interface ToolTimelineItemProps {
  item: Extract<MessageTimelineItem, { type: 'tool' | 'tool-group' }>
  streaming: boolean
  now?: number
  projectId?: string
}

function groupDuration(
  activities: Extract<MessageTimelineItem, { type: 'tool-group' }>['activities'],
  running: boolean,
  now: number,
  t: TFunction,
): string {
  let startedAt: number | null = null
  let endedAt: number | null = null
  for (const activity of activities) {
    if (activity.startedAt !== undefined) {
      startedAt = startedAt === null ? activity.startedAt : Math.min(startedAt, activity.startedAt)
    }
    const activityEndedAt = activity.endedAt
      ?? (running && !activity.hasResult ? now : undefined)
    if (activityEndedAt !== undefined) {
      endedAt = endedAt === null ? activityEndedAt : Math.max(endedAt, activityEndedAt)
    }
  }
  return formatDuration(durationMilliseconds(startedAt, endedAt) ?? Number.NaN, t)
}

export default function ToolTimelineItem({
  item,
  streaming,
  now = Date.now(),
  projectId,
}: ToolTimelineItemProps) {
  const { t } = useI18n()
  if (item.type === 'tool') {
    return (
      <ToolCallRow
        activity={item.activity}
        messageRunning={streaming}
        now={now}
        projectId={projectId}
      />
    )
  }

  const running = streaming && item.activities.some((activity) => !activity.hasResult)
  const failed = item.activities.some((activity) => activity.isError)
  const duration = groupDuration(item.activities, running, now, t)
  return (
    <details className={`llm-tool-group llm-tool-group-${running ? 'running' : failed ? 'failed' : 'done'}`}>
      <summary>
        <span className="llm-tool-call-icon" aria-hidden="true">
          <Icon name="terminal" size={13} strokeWidth={1.7} />
        </span>
        <span className={`llm-tool-call-summary${running ? ' is-shimmer' : ''}`}>
          {t('trace.commandGroup', { count: item.activities.length })}
          {duration && t('trace.commandDuration', { duration })}
        </span>
        {failed && <span className="process-trace-error">{t('trace.failed')}</span>}
        <Icon name="chevron-down" size={12} strokeWidth={1.8} className="llm-tool-call-chevron" />
      </summary>
      <div className="llm-tool-group-items">
        {item.activities.map((activity) => (
          <ToolCallRow
            key={activity.id}
            activity={activity}
            messageRunning={streaming}
            now={now}
            projectId={projectId}
          />
        ))}
      </div>
    </details>
  )
}
