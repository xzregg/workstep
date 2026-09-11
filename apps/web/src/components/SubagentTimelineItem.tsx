import { useEffect, useState } from 'react'
import MarkdownMessage from './MarkdownMessage'
import ToolTimelineItem from './ToolTimelineItem'
import { buildMessageTimeline } from '../utils/messageTimeline'
import Icon from './Icon'
import { useI18n } from '../i18n'
import type { MessageTimelineItem } from '../utils/messageTimeline'

interface SubagentTimelineItemProps {
  item: Extract<MessageTimelineItem, { type: 'subagent' }>
  projectId?: string
  messageRunning: boolean
  /** 是否为同级最后一个子代理；与思考块一致，仅自动展开最后一项。 */
  lastSubagent: boolean
}

const NON_TERMINAL = new Set(['pending', 'running', 'in_progress'])

export default function SubagentTimelineItem({
  item,
  messageRunning,
  projectId,
  lastSubagent,
}: SubagentTimelineItemProps) {
  const { t } = useI18n()
  const { activity } = item
  const active = messageRunning && NON_TERMINAL.has(activity.status)
  const [open, setOpen] = useState(active && lastSubagent)
  useEffect(() => {
    if (active && lastSubagent) {
      setOpen(true)
    } else if (!lastSubagent) {
      setOpen(false)
    }
  }, [active, lastSubagent])
  const timeline = buildMessageTimeline(activity.events ?? [])
  const nestedSubagents = timeline.filter(
    (entry): entry is Extract<MessageTimelineItem, { type: 'subagent' }> => entry.type === 'subagent',
  )
  const lastNestedSubagent = nestedSubagents[nestedSubagents.length - 1]
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
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className={`subagent-timeline llm-tool-call llm-tool-call-${active ? 'running' : failed ? 'failed' : 'done'}`}>
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
        {timeline.map((entry, index) => {
          const streaming = active && index === timeline.length - 1
          if (entry.type === 'tool' || entry.type === 'tool-group') {
            return <ToolTimelineItem key={entry.id} item={entry} streaming={active} projectId={projectId} />
          }
          if (entry.type === 'subagent') {
            return (
              <SubagentTimelineItem
                key={entry.id}
                item={entry}
                lastSubagent={entry === lastNestedSubagent}
                messageRunning={active}
                projectId={projectId}
              />
            )
          }
          if (entry.type === 'thinking') {
            return <div key={entry.id} className="process-trace-thinking">{entry.content.trimStart()}</div>
          }
          return <div key={entry.id} className="process-trace-commentary">
            <MarkdownMessage
              className="subagent-event-markdown"
              compactParagraphs
              content={entry.content}
              streaming={streaming}
              projectId={projectId}
            />
          </div>
        })}
        {!timeline.length && activity.lastToolName && (
          <div className="subagent-last-tool">
            <span>{t('trace.subagentLastTool')}</span>
            <code>{activity.lastToolName}</code>
          </div>
        )}
        {activity.summary ? (
          <div>
            <span>{t('trace.subagentSummary')}</span>
            <pre>{activity.summary}</pre>
          </div>
        ) : (
          !timeline.length && !activity.lastToolName && <div className="process-trace-empty">{t('trace.noDetails')}</div>
        )}
      </div>
    </details>
  )
}
