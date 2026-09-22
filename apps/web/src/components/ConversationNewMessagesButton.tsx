import Icon from './Icon'

interface ConversationNewMessagesButtonProps {
  visible: boolean
  /** When true, shows text label + arrow (new messages arrived). When false, shows arrow only. */
  hasNewMessages?: boolean
  label: string
  ariaLabel: string
  onClick: () => void
}

/** Shared affordance shown when a conversation is not scrolled to bottom. */
export default function ConversationNewMessagesButton({
  visible,
  hasNewMessages,
  label,
  ariaLabel,
  onClick,
}: ConversationNewMessagesButtonProps) {
  return (
    <div className="conversation-new-messages-region" aria-live="polite">
      {visible && (
        <button
          type="button"
          className={`conversation-new-messages-button${hasNewMessages ? ' has-label' : ''}`}
          onClick={onClick}
          aria-label={ariaLabel}
        >
          {hasNewMessages && label}
          <Icon name="chevron-down" size={hasNewMessages ? 13 : 18} strokeWidth={2.2} />
        </button>
      )}
    </div>
  )
}
