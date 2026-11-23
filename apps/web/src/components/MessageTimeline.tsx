import { memo, Profiler, useState, type ProfilerOnRenderCallback, type ReactElement } from 'react'
import { runtimeMark } from '../utils/runtimeDiagnostics'
import ProposedPlanMessage from './ProposedPlanMessage'
import {
  buildMessageTimeline,
  timelineText,
  type MessageTimelineEvent,
} from '../utils/messageTimeline'

interface MessageTimelineProps {
  content: string
  events: MessageTimelineEvent[]
  streaming?: boolean
  projectId?: string
  suppressTextPlan?: boolean
}

/**
 * memo 化：buildMessageTimeline + 分段 markdown 是 assistant 消息的主要渲染成本。
 * 历史消息的 content（字符串按值比较）与 events（引用不变）都稳定，
 * 流式时父级每个 token 重渲染也不会重算历史时间线。
 */
function MessageTimeline({
  content,
  events,
  streaming = false,
  projectId,
  suppressTextPlan = false,
}: MessageTimelineProps) {
  const timeline = buildMessageTimeline(events)
  const [initialTextIds] = useState(() => new Set(timeline.filter(item => item.type === 'text').map(item => item.id)))
  const streamedText = timelineText(timeline)
  const canInterleaveText = Boolean(streamedText) && (
    content.startsWith(streamedText) || streamedText.startsWith(content)
  )
  const [hasInitialTrailing] = useState(() => canInterleaveText
    && content.length > streamedText.length && content.startsWith(streamedText))

  // A single text run has no process boundary to display. Keep the full body
  // together even when the rolling event window happens to match a prefix.
  if (!canInterleaveText || (timeline.length === 1 && timeline[0].type === 'text')) {
    // Keep the same shell and first child before/after the first text event.
    // A live paragraph must update the empty renderer, not mount as history.
    return profileTimeline(<div className="llm-message-timeline">
      <ProposedPlanMessage key="body" content={content} streaming={streaming} projectId={projectId} suppressPlan={suppressTextPlan} />
    </div>)
  }

  const textItems = timeline.filter(
    (item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text',
  )
  const trailingContent = content.startsWith(streamedText)
    ? content.slice(streamedText.length)
    : ''
  return profileTimeline(
    <div className="llm-message-timeline">
      {textItems.map((item, index) => (
        <ProposedPlanMessage
          key={index === 0 ? 'body' : item.id}
          content={item.content}
          revealInitial={!initialTextIds.has(item.id)}
          streaming={streaming && item === textItems[textItems.length - 1] && !trailingContent}
          projectId={projectId}
          suppressPlan={suppressTextPlan}
        />
      ))}
      {trailingContent && (
        <ProposedPlanMessage key="trailing" content={trailingContent} revealInitial={!hasInitialTrailing} streaming={streaming} projectId={projectId} suppressPlan={suppressTextPlan} />
      )}
    </div>
  )
}

const measure: ProfilerOnRenderCallback = (_id, _phase, duration, _baseDuration, startedAt) => {
  runtimeMark('chat-react-render', startedAt, duration)
}

function profileTimeline(timeline: ReactElement) {
  return import.meta.env?.MODE === 'profile'
    ? <Profiler id="MessageTimeline" onRender={measure}>{timeline}</Profiler>
    : timeline
}

export default memo(MessageTimeline)
