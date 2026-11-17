import { useEffect, useRef, useState } from 'react'
import { engineApi, type EngineInfo } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import EngineSelect, { engineOptionLabel, isEngineSelectable } from './EngineSelect'
import ConfirmDialog from './ConfirmDialog'
import { engineLabel } from '../engineMeta'
import './ExecutionDefaultSettings.css'

interface Props {
  engines: EngineInfo[]
  loading: boolean
  onChanged?: () => void
}

export default function ExecutionDefaultSettings({ engines, loading, onChanged }: Props) {
  const { t } = useI18n()
  const [engine, setEngine] = useState('')
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(false)
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const load = async () => {
      setLoadingConfig(true)
      setError('')
      setNotice('')
      try {
        const config = await engineApi.executionConfig()
        setEngine(config.engine || config.resolved_engine || '')
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('settings.readDefaultFailed'))
      } finally {
        setLoadingConfig(false)
      }
    }
    void load()
  }, [t])

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await engineApi.setExecutionConfig(draft)
      setEngine(result.engine || result.resolved_engine || '')
      setOpen(false)
      setNotice(t('settings.saveDefaultSuccess'))
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const current = engines.find((item) => item.id === engine)
  const selected = engines.find((item) => item.id === draft)
  const canSave = Boolean(selected && selected.enabled !== false && isEngineSelectable(selected))
  const edit = () => {
    setDraft(engine)
    setError('')
    setNotice('')
    setOpen(true)
  }
  const close = () => {
    if (saving) return
    if (draft !== engine) setConfirmDiscard(true)
    else setOpen(false)
  }

  return (
    <>
      <div id="settings-default-execution-engine" className="execution-default-settings">
        <div className="execution-default-settings-summary">
          <div className="execution-default-settings-title">{t('settings.defaultExecutionEngine')}</div>
          <div className="execution-default-settings-current">
            {loadingConfig ? t('common.loading') : current ? engineOptionLabel(current, false, t) : engineLabel(engine, t)}
          </div>
        </div>
        <Button variant="ghost" className="execution-default-settings-edit"
          disabled={loading || loadingConfig} onClick={edit}>
          {t('common.edit')}
        </Button>
        {(error || notice) && !open && (
          <div role={error ? 'alert' : 'status'}
            className={`execution-default-settings-feedback execution-default-settings-feedback--${error ? 'error' : 'success'}`}>
            {error || notice}
          </div>
        )}
      </div>
      <ConfirmDialog open={open} title={t('settings.defaultExecutionEngine')}
        message={t('settings.defaultEngineHint')} width={480}
        confirmText={t('settings.saveDefault')} confirmDisabled={!canSave || saving || loading || loadingConfig}
        loading={saving} onConfirm={() => void save()} onCancel={close}>
        <EngineSelect engines={engines} value={draft} onChange={setDraft}
          disabled={loading || saving || loadingConfig}
          ariaLabel={t('settings.defaultEngineAria')}
          className="execution-default-settings-select" />
        {error && <div role="alert" className="execution-default-settings-feedback execution-default-settings-feedback--error">{error}</div>}
      </ConfirmDialog>
      <ConfirmDialog open={confirmDiscard} title={t('canvas.unsavedTitle')}
        message={t('canvas.unsavedLeaveMessage')} confirmText={t('common.discard')}
        cancelText={t('common.cancel')} zIndex={2100}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => { setConfirmDiscard(false); setOpen(false) }} />
    </>
  )
}
