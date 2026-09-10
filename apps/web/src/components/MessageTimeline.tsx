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

export default function MessageTimeline({
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
