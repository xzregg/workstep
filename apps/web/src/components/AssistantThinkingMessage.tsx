import { useState, type ReactNode } from 'react'
import ChatMessageBubble from './ChatMessageBubble'
import StreamingStatusText from './StreamingStatusText'
import { useI18n } from '../i18n'
import ProcessTrace from './ProcessTrace'

interface AssistantThinkingMessageProps {
  sender: string
  initials: ReactNode
  color?: string
  animatedAvatar?: boolean
  /** Rendered under the placeholder (e.g. usage footer with engine * model). */
  footer?: ReactNode
  startedAt?: string | number | null
}

/** Shared optimistic assistant reply shown before the first live LLM event. */
export default function AssistantThinkingMessage({
  sender,
  initials,
  color = 'var(--ai-assistant)',
  animatedAvatar = false,
  footer,
  startedAt,
}: AssistantThinkingMessageProps) {
  const { t } = useI18n()
  const [waitingSince] = useState(() => Date.now())
  return (
    <ChatMessageBubble
      animatedAvatar={animatedAvatar}
      role="assistant"
      sender={sender}
      initials={initials}
      color={color}
      content=""
      streaming
      variant="bg"
      showLoading
      header={<ProcessTrace events={[]} running compact startedAt={startedAt ?? waitingSince} />}
      loading={<StreamingStatusText label={t('bubble.thinking')} />}
      footer={footer}
    />
  )
}
