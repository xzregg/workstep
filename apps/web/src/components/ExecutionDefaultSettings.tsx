import { useEffect, useRef, useState } from 'react'
import { engineApi, type EngineInfo } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import EngineSelect from './EngineSelect'
import './ExecutionDefaultSettings.css'

interface Props {
  engines: EngineInfo[]
  loading: boolean
  onChanged?: () => void
}

export default function ExecutionDefaultSettings({ engines, loading, onChanged }: Props) {
  const { t } = useI18n()
  const [engine, setEngine] = useState('')
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
        setEngine(config.engine || config.resolved_engine)
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
      const result = await engineApi.setExecutionConfig(engine)
      setEngine(result.engine || result.resolved_engine)
      setNotice(t('settings.saveDefaultSuccess'))
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div id="settings-default-execution-engine" className="execution-default-settings">
      <div className="execution-default-settings-title">{t('settings.defaultExecutionEngine')}</div>
      <div className="execution-default-settings-hint">{t('settings.defaultEngineHint')}</div>
      <div className="execution-default-settings-controls">
        <EngineSelect engines={engines} value={engine} onChange={setEngine}
          disabled={loading || saving || loadingConfig}
          ariaLabel={t('settings.defaultEngineAria')}
          className="execution-default-settings-select" />
        <Button variant="primary" className="execution-default-settings-save"
          disabled={saving || loading || loadingConfig} loading={saving} onClick={() => void save()}>
          {t('settings.saveDefault')}
        </Button>
      </div>
      {(error || notice) && (
        <div role={error ? 'alert' : 'status'}
          className={`execution-default-settings-feedback execution-default-settings-feedback--${error ? 'error' : 'success'}`}>
          {error || notice}
        </div>
      )}
    </div>
  )
}
