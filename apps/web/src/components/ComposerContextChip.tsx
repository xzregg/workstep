import type { ReactNode } from 'react'
import Icon from './Icon'
import './ComposerContextChip.css'

/** Presentation only: context bindings stay separate from the editable message. */
export default function ComposerContextChip({ name, icon, disabled, unavailable, onOpen, onRemove, removeLabel, openLabel, className = '', nameClassName = '', removeClassName = '' }: {
  name: string; icon: ReactNode; disabled?: boolean; unavailable?: boolean
  onOpen?: () => void; onRemove: () => void; removeLabel: string; openLabel?: string
  className?: string; nameClassName?: string; removeClassName?: string
}) {
  const content = <>{icon}<span className="composer-context-chip-label">{name}</span></>
  return <span className={`composer-context-chip ${className}`} data-unavailable={unavailable || undefined} contentEditable={false}>
    {onOpen
      ? <button type="button" className={`composer-context-chip-name ${nameClassName}`} disabled={disabled} onClick={onOpen} title={name} aria-label={openLabel || name}>{content}</button>
      : <span className="composer-context-chip-name" title={name}>{content}</span>}
    <button type="button" className={`composer-context-chip-remove ${removeClassName}`} disabled={disabled} onClick={onRemove} aria-label={removeLabel}><Icon name="x" size={12} /></button>
  </span>
}
