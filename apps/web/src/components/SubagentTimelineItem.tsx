import { memo, useEffect, useMemo, useState } from 'react'
import MarkdownMessage from './MarkdownMessage'
import useStreamReveal from '../hooks/useStreamReveal'

/** 子代理思考正文：独立组件（map 内不能直接调 hook），套揭示层柔滑浮现 */
const SubagentThinkingText = memo(function SubagentThinkingText({
  content,
  streaming,
}: {
  content: string
  streaming: boolean
}) {
  const shown = useStreamReveal(content, streaming, false, true)
  return <div className="process-trace-thinking">{shown.trimStart()}</div>
})
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

/**
 * 折叠时不渲染 body、展开时渲染条目封顶。子代理内层事件可达数千条，
 * 原生 <details> 折叠只是 CSS 隐藏，全量 DOM 照建——多个子代理叠加会把
 * 渲染进程内存直接打爆；封顶避免展开时一次性挂载上万节点。
 */
const MAX_RENDERED_SUBAGENT_ITEMS = 400

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
  const [showAllItems, setShowAllItems] = useState(false)
  useEffect(() => {
    if (active && lastSubagent) {
      setOpen(true)
    } else if (!lastSubagent) {
      setOpen(false)
    }
  }, [active, lastSubagent])
  const timeline = useMemo(
    () => buildMessageTimeline(activity.events ?? []),
    [activity.events],
  )
  const nestedSubagents = useMemo(
    () => timeline.filter(
      (entry): entry is Extract<MessageTimelineItem, { type: 'subagent' }> => entry.type === 'subagent',
    ),
    [timeline],
  )
  const lastNestedSubagent = nestedSubagents[nestedSubagents.length - 1]
  const hiddenItemCount = !showAllItems && timeline.length > MAX_RENDERED_SUBAGENT_ITEMS
    ? timeline.length - MAX_RENDERED_SUBAGENT_ITEMS
    : 0
  const visibleTimeline = hiddenItemCount > 0 ? timeline.slice(hiddenItemCount) : timeline
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
      {open && (
      <div className="llm-tool-call-detail">
        {hiddenItemCount > 0 && (
          <div className="process-trace-empty">
            {t('trace.itemsHidden', { count: hiddenItemCount })}
            <button
              type="button"
              className="process-trace-show-all"
              onClick={() => setShowAllItems(true)}
            >
              {t('trace.showAllItems', { count: timeline.length })}
            </button>
          </div>
        )}
        {visibleTimeline.map((entry) => {
          const streaming = active && entry === timeline[timeline.length - 1]
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
            return <SubagentThinkingText key={entry.id} content={entry.content} streaming={streaming} />
          }
          return <div key={entry.id} className="process-trace-commentary">
            <MarkdownMessage
              className="subagent-event-markdown"
              compactParagraphs
              content={entry.content}
              streaming={streaming}
              projectId={projectId}
              /* 嵌套时间线文本密、更新快，先保持原样渲染，不套揭示层 */
              reveal="off"
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
      )}
    </details>
  )
}
