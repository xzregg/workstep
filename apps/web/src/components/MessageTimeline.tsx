import { memo } from 'react'
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
  if (!content) return null
  const timeline = buildMessageTimeline(events)
  const streamedText = timelineText(timeline)
  const canInterleaveText = Boolean(streamedText) && (
    content.startsWith(streamedText) || streamedText.startsWith(content)
  )

  if (!canInterleaveText) {
    return <MarkdownMessage content={content} streaming={streaming} projectId={projectId} />
  }

  const textItems = timeline.filter(
    (item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text',
  )
  const trailingContent = content.startsWith(streamedText)
    ? content.slice(streamedText.length)
    : ''
  return (
    <div className="llm-message-timeline">
      {textItems.map((item) => (
        <MarkdownMessage
          key={item.id}
          content={item.content}
          streaming={streaming && item === textItems[textItems.length - 1] && !trailingContent}
          projectId={projectId}
        />
      ))}
      {trailingContent && (
        <MarkdownMessage content={trailingContent} streaming={streaming} projectId={projectId} />
      )}
    </div>
  )
}

export default memo(MessageTimeline)
