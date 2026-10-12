import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../hooks/useOverlay'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import ResizablePanel from './ResizablePanel'
import SkinSettings from './SkinSettings'
import './SkinCenterEntry.css'

function SkinCenterDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(true, onClose, ref)
  return createPortal(<div className="skin-center-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><ResizablePanel ref={ref} className="skin-center-dialog" role="dialog" aria-modal="true" aria-label={t('skins.centerTitle')} minWidth={640} minHeight={460}>
    <header className="skin-center-dialog-header" data-dialog-drag-handle><span>{t('skins.title')}</span><Button variant="icon" aria-label={t('common.close')} onClick={onClose}><Icon name="x" size={18} /></Button></header>
    <main className="skin-center-dialog-content"><SkinSettings /></main>
  </ResizablePanel></div>, document.body)
}

/** System appearance entry owns the skin center dialog lifecycle. */
export default function SkinCenterEntry({ className = '' }: { className?: string } = {}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return <><Button variant="ghost" className={`skin-center-entry ${className}`} onClick={() => setOpen(true)}><Icon name="sparkles" size={17} />{t('skins.appearance')}</Button>{open && <SkinCenterDialog onClose={() => setOpen(false)} />}</>
}
