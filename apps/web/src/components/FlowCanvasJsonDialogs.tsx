import { useEffect, useState } from 'react'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import Textarea from './Textarea'
import { useI18n } from '../i18n'
import { copyText } from '../utils/clipboard'
import './FlowCanvasJsonDialogs.css'

interface Props {
  exportOpen: boolean
  importOpen: boolean
  onCloseExport: () => void
  onCloseImport: () => void
  getSteps: () => unknown
  onImport: (steps: unknown) => void
  onFeedback: (message: string, kind: 'success' | 'error', duration?: number) => void
}

export default function FlowCanvasJsonDialogs({
  exportOpen, importOpen, onCloseExport, onCloseImport, getSteps, onImport, onFeedback,
}: Props) {
  const { t } = useI18n()
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')

  useEffect(() => {
    if (importOpen) {
      setImportText('')
      setImportError('')
    }
  }, [importOpen])

  const copyJson = () => {
    void copyText(JSON.stringify(getSteps(), null, 2)).then((ok) => {
      onFeedback(ok ? t('flow.copyJsonSuccess') : t('flow.copyFailed'), ok ? 'success' : 'error', 3000)
    })
  }

  const importJson = () => {
    try {
      const parsed = JSON.parse(importText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('flow.jsonShapeError'))
      }
      onImport(parsed)
      onCloseImport()
      setImportText('')
      setImportError('')
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t('flow.jsonParseError'))
    }
  }

  return (
    <>
      {exportOpen && (
        <div className="modal-overlay flow-json-overlay" onClick={onCloseExport}>
          <ResizablePanel className="modal flow-json-export" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.jsonConfigTitle')}</span>
              <Button variant="icon" aria-label={t('common.close')} onClick={onCloseExport}>✕</Button>
            </div>
            <div className="modal-body flow-json-export-body">
              <pre className="flow-json-preview">{JSON.stringify(getSteps(), null, 2)}</pre>
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={copyJson}>{t('common.copy')}</Button>
              <Button variant="primary" onClick={onCloseExport}>{t('common.close')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}
      {importOpen && (
        <div className="modal-overlay flow-json-overlay" onClick={onCloseImport}>
          <ResizablePanel className="modal flow-json-import" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('flow.importJsonTitle')}</span>
              <Button variant="icon" aria-label={t('common.cancel')} onClick={onCloseImport}>✕</Button>
            </div>
            <div className="modal-body">
              <Textarea className="flow-json-editor" value={importText}
                onChange={(event) => { setImportText(event.target.value); setImportError('') }}
                placeholder={t('flow.importPlaceholder')} spellCheck={false} />
              {importError && <p className="flow-json-error" role="alert">{importError}</p>}
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={onCloseImport}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={importJson} disabled={!importText.trim()}>{t('flow.confirmImport')}</Button>
            </div>
          </ResizablePanel>
        </div>
      )}
    </>
  )
}
