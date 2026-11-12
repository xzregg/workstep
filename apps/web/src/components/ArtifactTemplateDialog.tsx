import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import MarkdownEditor from './MarkdownEditor'
import ResizablePanel from './ResizablePanel'
import './ArtifactTemplateDialog.css'

interface Props {
  name: string
  value: string
  sourceValue?: string
  onSave?: (value: string) => void | Promise<void>
  onClose: () => void
}

/** Shared draft, save errors and close protection for workflow and task templates. */
export default function ArtifactTemplateDialog({ name, value, sourceValue, onSave, onClose }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const close = () => {
    if (saving) return
    if (draft !== value) setConfirmClose(true)
    else onClose()
  }
  const compact = useCompactLayout()
  useOverlay(true, close, panelRef, compact)
  const save = async () => {
    if (!onSave || saving) return
    setSaving(true)
    setError('')
    try { await onSave(draft); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  return createPortal(<div className="artifact-template-overlay" onClick={event => {
    event.stopPropagation()
    if (event.target === event.currentTarget) close()
  }} onKeyDown={event => event.stopPropagation()}>
    <ResizablePanel ref={panelRef} className="artifact-template-dialog" minWidth={360} minHeight={280}
      role="dialog" aria-modal="true" aria-label={`${t('artifactTemplate.title')} · ${name}`} tabIndex={-1}>
      <div className="dialog-header">
        <strong>{t('artifactTemplate.title')}</strong><span className="artifact-template-name">{name}</span>
        <Button variant="icon" aria-label={t('common.close')} disabled={saving} onClick={close}>×</Button>
      </div>
      <div className="artifact-template-body">
        <MarkdownEditor value={draft} onChange={setDraft} allowAttachments={false}
          disabled={saving} readOnly={!onSave} minHeight={0} maxHeight="100%"
          ariaLabel={t('artifactTemplate.title')} placeholder={t('artifactTemplate.placeholder')} />
      </div>
      {error && <div className="artifact-template-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        {onSave && sourceValue !== undefined && <Button variant="ghost" className="artifact-template-reset"
          disabled={saving} onClick={() => setDraft(sourceValue)}>{t('artifactTemplate.reset')}</Button>}
        <Button variant="ghost" disabled={saving} onClick={close}>{t(onSave ? 'common.cancel' : 'common.close')}</Button>
        {onSave && <Button variant="primary" loading={saving} disabled={saving} onClick={() => void save()}>{t('common.save')}</Button>}
      </div>
    </ResizablePanel>
    <ConfirmDialog open={confirmClose} title={t('taskWorkflow.discard')} onCancel={() => setConfirmClose(false)} onConfirm={onClose} />
  </div>, document.body)
}
