import Icon from './Icon'
import { useI18n } from '../i18n'
import type { MessageTimelineItem } from '../utils/messageTimeline'

interface SubagentTimelineItemProps {
  item: Extract<MessageTimelineItem, { type: 'subagent' }>
  messageRunning: boolean
}

const NON_TERMINAL = new Set(['pending', 'running', 'paused', 'in_progress'])

export default function SubagentTimelineItem({
  item,
  messageRunning,
}: SubagentTimelineItemProps) {
  const { t } = useI18n()
  const { activity } = item
  const active = messageRunning && NON_TERMINAL.has(activity.status)
  const failed = activity.status === 'failed'
  const stopped = activity.status === 'stopped' || activity.status === 'killed'
  const label = active
    ? t('trace.subagentRunning')
    : failed
      ? t('trace.subagentFailed')
      : stopped
        ? t('trace.subagentStopped')
        : t('trace.subagentDone')

  return (
    <details className={`llm-tool-call llm-tool-call-${active ? 'running' : failed ? 'failed' : 'done'}`}>
      <summary title={activity.description}>
        <span className="llm-tool-call-icon" aria-hidden="true">
          {active
            ? <span className="task-status-spinner" />
            : <Icon name="bot" size={13} strokeWidth={1.7} />}
        </span>
        <span className="llm-tool-call-summary">
          {activity.description ? `${label}：${activity.description}` : label}
        </span>
        {failed && <span className="process-trace-error">{t('trace.failed')}</span>}
        <Icon name="chevron-down" size={12} strokeWidth={1.8} className="llm-tool-call-chevron" />
      </summary>
      <div className="llm-tool-call-detail">
        {activity.summary ? (
          <div>
            <span>{t('trace.subagentSummary')}</span>
            <pre>{activity.summary}</pre>
          </div>
        ) : (
          <div className="process-trace-empty">{t('trace.noDetails')}</div>
        )}
      </div>
    </details>
  )
}
