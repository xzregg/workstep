import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import { useOverlay } from '../hooks/useOverlay'
import { copyText } from '../utils/clipboard'
import { summarizeProviderProtocolModels, type ProviderProtocolModels } from '../utils/providerModels'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import './ProviderSavedModels.css'

interface Props {
  providerName: string
  groups: ProviderProtocolModels[]
  protocolLabel: (protocol: string) => string
}

/** Read-only access to the saved cache, independent of model discovery and selection. */
export default function ProviderSavedModels({ providerName, groups, protocolLabel }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [copyResult, setCopyResult] = useState<{ name: string; success: boolean } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const summary = useMemo(() => summarizeProviderProtocolModels(groups), [groups])
  useOverlay(open, () => setOpen(false), panelRef, false)

  if (summary.uniqueCount === 0) return null
  const title = `${providerName} · ${t('providerSettings.modelsDetails')}`

  return <>
    <Button
      variant="ghost"
      className="provider-saved-models-count"
      aria-haspopup="dialog"
      title={t('providerSettings.modelsDetails')}
      onClick={() => { setCopyResult(null); setOpen(true) }}
    >
      {t('providerSettings.modelsCount', { count: summary.uniqueCount })}
    </Button>
    {open && createPortal(
      <div
        className="modal-overlay provider-saved-models-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
      >
        <ResizablePanel ref={panelRef} className="modal provider-saved-models-panel">
          <div className="modal-header">
            <span className="modal-title">{title}</span>
            <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={() => setOpen(false)}>✕</Button>
          </div>
          <div className="provider-saved-models-body">
            {summary.groups.filter((group) => group.models.length > 0).map((group) => (
              <section key={group.protocol} data-model-protocol={group.protocol}>
                <h2 className="provider-saved-models-heading">
                  {protocolLabel(group.protocol)} · {t('providerSettings.modelsCount', { count: group.models.length })}
                </h2>
                <ul className="provider-saved-models-list">
                  {group.models.map((model) => (
                    <li key={model.id} title={model.description || model.label || model.id}>
                      <Button
                        variant="ghost"
                        className="provider-saved-models-tag"
                        aria-label={t('providerSettings.modelsCopyName', { name: model.id })}
                        onClick={async () => {
                          const success = await copyText(model.id)
                          setCopyResult({ name: model.id, success })
                        }}
                      >{model.id}</Button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div
            className={`provider-saved-models-copy-status${copyResult?.success === false ? ' provider-saved-models-copy-status--error' : ''}`}
            role={copyResult?.success === false ? 'alert' : 'status'}
          >
            {copyResult
              ? `${copyResult.success ? t('common.copied') : t('meta.copyFailed')} · ${copyResult.name}`
              : t('providerSettings.modelsCopyHint')}
          </div>
        </ResizablePanel>
      </div>,
      document.body,
    )}
  </>
}
