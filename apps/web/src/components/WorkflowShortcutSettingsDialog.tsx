import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { chatSessionApi, type ChatQuickButton } from '../api/client'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import QuickButtonEditor, { quickButtonFromDraft, quickButtonToDraft } from './QuickButtonEditor'
import ResizablePanel from './ResizablePanel'

interface Props {
  projectId: string
  workflowId: string
  workflowName: string
  workflowButtons: ChatQuickButton[]
  selectedIds?: string[]
  inheritByDefault: boolean
  onSave: (selectedIds: string[], workflowButtons: ChatQuickButton[]) => Promise<void>
  onClose: () => void
}

export default function WorkflowShortcutSettingsDialog({ projectId, workflowId, workflowName, workflowButtons, selectedIds, inheritByDefault, onSave, onClose }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const [buttons, setButtons] = useState<ChatQuickButton[]>([])
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [initialIds, setInitialIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const [localButtons, setLocalButtons] = useState(() => workflowButtons.map(quickButtonToDraft))
  const [selectedLocalId, setSelectedLocalId] = useState(workflowButtons[0]?.id || '')
  const initialLocalJson = useState(() => JSON.stringify(workflowButtons.map(quickButtonToDraft)))[0]

  useEffect(() => {
    let cancelled = false
    void chatSessionApi.quickButtons(projectId).then(({ buttons: available }) => {
      if (cancelled) return
      const ids = selectedIds === undefined
        ? inheritByDefault ? available.map((button) => button.id) : []
        : available.filter((button) => selectedIds.includes(button.id)).map((button) => button.id)
      setButtons(available)
      setCheckedIds(ids)
      setInitialIds(ids)
    }).catch((reason) => {
      if (!cancelled) {
        setLoadFailed(true)
        setError(reason instanceof Error ? reason.message : t('actionShortcuts.projectButtonLoadFailed'))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [projectId]) // The dialog is remounted for each workflow.

  const dirty = [...checkedIds].sort().join('\0') !== [...initialIds].sort().join('\0') || JSON.stringify(localButtons) !== initialLocalJson
  const requestClose = () => dirty ? setConfirmClose(true) : onClose()
  const save = async () => {
    for (const button of localButtons) {
      if (!button.label.trim()) { setSelectedLocalId(button.id); setError(t('chatSession.buttonLabelRequired')); return }
      if (button.kind === 'action' && (!button.actionId.trim() || !button.scriptPath.trim())) {
        setSelectedLocalId(button.id)
        setError(t('actionShortcuts.actionScriptRequired'))
        return
      }
    }
    setSaving(true)
    setError('')
    try {
      await onSave(checkedIds, localButtons.map(quickButtonFromDraft))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('actionShortcuts.saveFailed'))
    } finally {
      setSaving(false)
    }
  }
  const typeLabel = (button: ChatQuickButton) => button.kind === 'action'
    ? t('projectSettings.assistant.buttonTypeAction')
    : button.kind === 'display'
      ? t('projectSettings.assistant.buttonTypeDisplay')
      : t('projectSettings.assistant.buttonTypePrompt')

  return createPortal(<div className="project-directory-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) requestClose() }}>
    <ResizablePanel className="project-directory-dialog" role="dialog" aria-modal="true" aria-label={t('actionShortcuts.quickButtons')} minWidth={compact ? 0 : 660} minHeight={compact ? 0 : 450} style={{ width: compact ? '100%' : 860, height: compact ? 'calc(var(--app-viewport-height, 100dvh) - 16px)' : '75vh' }}>
      <header className="project-directory-dialog-header"><strong>{t('actionShortcuts.quickButtons')} · {workflowName}</strong><Button variant="icon" aria-label={t('actionShortcuts.close')} onClick={requestClose} style={{ padding: 0 }}>×</Button></header>
      <div style={{ padding: 20, flex: 1, overflowY: 'auto' }}>
        <p style={{ margin: '0 0 14px', color: 'var(--muted)' }}>{t('actionShortcuts.projectButtonHint')}</p>
        {loading && <Icon name="loader-circle" className="git-spin" size={18} />}
        {!loading && buttons.length === 0 && <p>{t('actionShortcuts.projectButtonEmpty')}</p>}
        {!loading && buttons.length > 0 && <div data-testid="project-quick-buttons" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {buttons.map((button) => <label key={button.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={checkedIds.includes(button.id)} onChange={(event) => setCheckedIds((current) => event.target.checked ? [...current, button.id] : current.filter((id) => id !== button.id))} />
            <span>{button.label}</span>
            <small style={{ color: 'var(--muted)' }}>{typeLabel(button)}</small>
          </label>)}
        </div>}
        <h3 style={{ margin: '22px 0 12px', fontSize: 'calc(14px * var(--font-scale))' }}>{t('actionShortcuts.workflowButtons')}</h3>
        <QuickButtonEditor
          projectId={projectId}
          workflowId={workflowId}
          buttons={localButtons}
          onChange={setLocalButtons}
          selectedId={selectedLocalId}
          onSelect={setSelectedLocalId}
          onSave={() => { if (!loading && !loadFailed) void save() }}
          saving={saving}
          saveDisabled={loading || loadFailed}
          error={error}
          onEdited={() => setError('')}
        />
      </div>
      <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}><Button variant="ghost" onClick={requestClose}>{t('actionShortcuts.cancel')}</Button></footer>
    </ResizablePanel>
    <ConfirmDialog open={confirmClose} title={t('actionShortcuts.quickButtons')} message={t('actionShortcuts.unsavedClose')} confirmText={t('actionShortcuts.close')} onCancel={() => setConfirmClose(false)} onConfirm={onClose} />
  </div>, document.body)
}
