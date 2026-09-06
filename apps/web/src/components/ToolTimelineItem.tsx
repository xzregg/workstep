import Icon from './Icon'
import ToolCallRow from './ToolCallRow'
import { useI18n } from '../i18n'
import type { MessageTimelineItem } from '../utils/messageTimeline'

interface ToolTimelineItemProps {
  item: Extract<MessageTimelineItem, { type: 'tool' | 'tool-group' }>
  streaming: boolean
  projectId?: string
}

export default function ToolTimelineItem({ item, streaming, projectId }: ToolTimelineItemProps) {
  const { t } = useI18n()
  if (item.type === 'tool') {
    return <ToolCallRow activity={item.activity} messageRunning={streaming} projectId={projectId} />
  }

  const running = streaming && item.activities.some((activity) => !activity.hasResult)
  const failed = item.activities.some((activity) => activity.isError)
  return (
    <details className={`llm-tool-group llm-tool-group-${running ? 'running' : failed ? 'failed' : 'done'}`}>
      <summary>
        <span className="llm-tool-call-icon" aria-hidden="true">
          <Icon name="terminal" size={13} strokeWidth={1.7} />
        </span>
        <span className={`llm-tool-call-summary${running ? ' is-shimmer' : ''}`}>
          {t('trace.commandGroup', { count: item.activities.length })}
        </span>
        {failed && <span className="process-trace-error">{t('trace.failed')}</span>}
        <Icon name="chevron-down" size={12} strokeWidth={1.8} className="llm-tool-call-chevron" />
      </summary>
      <div className="llm-tool-group-items">
        {item.activities.map((activity) => (
          <ToolCallRow key={activity.id} activity={activity} messageRunning={streaming} projectId={projectId} />
        ))}
      </div>
    </details>
  )
}
