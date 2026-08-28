import Icon from './Icon'

interface ConversationNewMessagesButtonProps {
  visible: boolean
  label: string
  ariaLabel: string
  onClick: () => void
}

/** Shared affordance shown when a conversation stops following live output. */
export default function ConversationNewMessagesButton({
  visible,
  label,
  ariaLabel,
  onClick,
}: ConversationNewMessagesButtonProps) {
  return (
    <div className="conversation-new-messages-region" aria-live="polite">
      {visible && (
        <button
          type="button"
          className="conversation-new-messages-button"
          onClick={onClick}
          aria-label={ariaLabel}
        >
          {label}
          <Icon name="chevron-down" size={13} strokeWidth={2.2} />
        </button>
      )}
    </div>
  )
}
