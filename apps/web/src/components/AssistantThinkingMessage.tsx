import ChatMessageBubble from './ChatMessageBubble'
import MessageMetaBar from './MessageMetaBar'

interface AssistantThinkingMessageProps {
  sender: string
  initials: string
  label: string
  color?: string
  onViewPrompt?: (prompt: string) => void
}

const ignorePrompt = () => undefined

/** Shared optimistic assistant reply shown before the first live LLM event. */
export default function AssistantThinkingMessage({
  sender,
  initials,
  label,
  color = 'var(--ai-assistant)',
  onViewPrompt = ignorePrompt,
}: AssistantThinkingMessageProps) {
  return (
    <ChatMessageBubble
      role="assistant"
      sender={sender}
      initials={initials}
      color={color}
      content=""
      streaming
      variant="bg"
      header={
        <MessageMetaBar
          running
          events={[]}
          onViewPrompt={onViewPrompt}
        />
      }
      showLoading
      loading={
        <div
          className="engine-loading-message"
          role="status"
          aria-live="polite"
        >
          {label}
        </div>
      }
    />
  )
}
