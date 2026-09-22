import type { ReactNode } from 'react'
import ChatMessageBubble from './ChatMessageBubble'
import StreamingStatusText from './StreamingStatusText'
import { useI18n } from '../i18n'

interface AssistantThinkingMessageProps {
  sender: string
  initials: string
  color?: string
  /** Rendered under the placeholder (e.g. usage footer with engine * model). */
  footer?: ReactNode
}

/** Shared optimistic assistant reply shown before the first live LLM event. */
export default function AssistantThinkingMessage({
  sender,
  initials,
  color = 'var(--ai-assistant)',
  footer,
}: AssistantThinkingMessageProps) {
  const { t } = useI18n()
  return (
    <ChatMessageBubble
      role="assistant"
      sender={sender}
      initials={initials}
      color={color}
      content=""
      streaming
      variant="bg"
      showLoading
      loading={<StreamingStatusText label={t('bubble.thinking')} />}
      footer={footer}
    />
  )
}
