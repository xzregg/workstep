import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../hooks/useOverlay'
import { useI18n } from '../i18n'
import Icon from './Icon'

export default function MobileSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useI18n()
  useOverlay(open, onClose, ref)
  if (!open) return null
  return createPortal(<div className="mobile-sheet-backdrop" onClick={onClose}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="mobile-sheet" onClick={event => event.stopPropagation()}>
      <header><strong>{title}</strong><button onClick={onClose} aria-label={t('common.close')}><Icon name="x" size={20} /></button></header>
      <div className="mobile-sheet-body">{children}</div>
    </div>
  </div>, document.body)
}
