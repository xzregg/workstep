import type { ReactNode } from 'react'
import Button from './Button'
import Icon from './Icon'

export default function ChannelCard({
  name, description, status, statusLabel, enabled, enableDisabled, expanded,
  onToggleExpanded, onToggleEnabled, children,
}: {
  name: string
  description: string
  status: string
  statusLabel: string
  enabled: boolean
  enableDisabled?: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onToggleEnabled: (enabled: boolean) => void
  children: ReactNode
}) {
  return (
    <section className="channel-card">
      <div className="channel-card-header">
        <Button variant="icon" className="channel-expand" onClick={onToggleExpanded} aria-expanded={expanded}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={18} />
        </Button>
        <div className="wechat-mark" aria-hidden="true">微</div>
        <div className="channel-card-title">
          <strong>{name}</strong>
          <span>{description}</span>
        </div>
        <span className={`channel-status channel-status-${status}`}>{statusLabel}</span>
        <label className="channel-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={enableDisabled}
            onChange={(event) => onToggleEnabled(event.target.checked)}
          />
          <span />
        </label>
      </div>
      {expanded && <div className="channel-card-body">{children}</div>}
    </section>
  )
}
