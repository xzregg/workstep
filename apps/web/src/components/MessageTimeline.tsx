import { memo, useRef } from 'react'
import MarkdownMessage from './MarkdownMessage'
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
}: MessageTimelineProps) {
  const timeline = buildMessageTimeline(events)
  const initialTextIds = useRef(new Set(timeline.filter(item => item.type === 'text').map(item => item.id)))
  const streamedText = timelineText(timeline)
  const canInterleaveText = Boolean(streamedText) && (
    content.startsWith(streamedText) || streamedText.startsWith(content)
  )
  const initialTrailing = useRef(canInterleaveText && content.startsWith(streamedText)
    ? content.slice(streamedText.length) : '')

  if (!canInterleaveText) {
    // Keep the same shell and first child before/after the first text event.
    // A live paragraph must update the empty renderer, not mount as history.
    return <div className="llm-message-timeline">
      <MarkdownMessage key="body" content={content} streaming={streaming} projectId={projectId} />
    </div>
  }

  const textItems = timeline.filter(
    (item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text',
  )
  const trailingContent = content.startsWith(streamedText)
    ? content.slice(streamedText.length)
    : ''
  return (
    <div className="llm-message-timeline">
      {textItems.map((item, index) => (
        <MarkdownMessage
          key={index === 0 ? 'body' : item.id}
          content={item.content}
          revealInitial={!initialTextIds.current.has(item.id)}
          streaming={streaming && item === textItems[textItems.length - 1] && !trailingContent}
          projectId={projectId}
        />
      ))}
      {trailingContent && (
        <MarkdownMessage key="trailing" content={trailingContent} revealInitial={!initialTrailing.current} streaming={streaming} projectId={projectId} />
      )}
    </div>
  )
}

export default memo(MessageTimeline)
