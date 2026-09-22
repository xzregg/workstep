import { useCallback, useEffect, useRef, useState } from 'react'
import { engineApi, type EngineRuntimeCatalog, type EngineRuntimeOperation } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import Select from './Select'
import ConfirmDialog from './ConfirmDialog'
import Spinner from './Spinner'
import EngineInstallProgress, { formatPackageBytes } from './EngineInstallProgress'
import './EngineRuntimeControl.css'

const isRunning = (operation: EngineRuntimeOperation | null) => operation?.status === 'queued' || operation?.status === 'running'

export default function EngineRuntimeControl({ engineId, onChanged }: {
  engineId: string
  onChanged: () => void | Promise<void>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<EngineRuntimeCatalog | null>(null)
  const [version, setVersion] = useState('')
  const [operation, setOperation] = useState<EngineRuntimeOperation | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState(false)
  const [operationReady, setOperationReady] = useState(false)
  const [confirmation, setConfirmation] = useState<'install' | 'rollback' | null>(null)
  const [acceptTerms, setAcceptTerms] = useState(false)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const mounted = useRef(true)
  const running = isRunning(operation)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await engineApi.runtime(engineId)
      if (!mounted.current) return
      setCatalog(data)
      setVersion(previous => data.versions.some(item => item.version === previous) ? previous : data.default_version || '')
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [engineId])

  useEffect(() => {
    mounted.current = true
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const recover = async () => {
      try {
        const state = await engineApi.runtimeOperation(engineId)
        if (disposed) return
        setOperation(state)
        setOperationReady(true)
        setPollError(false)
        if (isRunning(state)) setOpen(true)
      } catch {
        if (disposed) return
        setPollError(true)
        timer = setTimeout(() => void recover(), 2000)
      }
    }
    void recover()
    return () => { disposed = true; mounted.current = false; clearTimeout(timer) }
  }, [engineId])

  useEffect(() => { if (open) void load() }, [open, load])

  useEffect(() => {
    if (!running) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const state = await engineApi.runtimeOperation(engineId)
        if (disposed) return
        if (!state) throw new Error('Missing operation')
        setPollError(false)
        setOperation(state)
        if (!isRunning(state)) {
          await load()
          await onChangedRef.current()
          return
        }
      } catch {
        if (disposed) return
        setPollError(true)
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [engineId, operation?.id, running, load])

  const submit = async () => {
    if (!confirmation || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const state = await engineApi.startRuntimeOperation(engineId, {
        ...(confirmation === 'install' ? { version } : {}),
        rollback: confirmation === 'rollback', accept_third_party_terms: acceptTerms,
      })
      if (!mounted.current) return
      setOperation(state)
      setPollError(false)
      setConfirmation(null)
      if (!isRunning(state)) {
        await load()
        await onChangedRef.current()
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('settings.runtimeStartError'))
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }
  const selected = catalog?.versions.find(item => item.version === version)
  const target = confirmation === 'rollback' ? catalog?.rollback_version : version
  const blocked = !operationReady || running || submitting || Boolean(catalog?.configured_path)
  const phaseLabel = operation?.stage === 'downloading' ? t('settings.runtimeDownloading')
    : operation?.stage === 'installing' ? t('settings.runtimeInstalling')
    : operation?.stage === 'verifying' ? t('settings.runtimeVerifying')
    : operation?.stage === 'completed' ? t('settings.runtimeCompleted') : t('settings.runtimePreparing')
  const ask = (action: 'install' | 'rollback') => { setAcceptTerms(false); setConfirmation(action) }
  return (
    <div className="engine-runtime-control">
      <Button variant="ghost" aria-expanded={open} aria-controls={`runtime-${engineId}`} onClick={() => setOpen(value => !value)}>
        {running && <Spinner />}{t('settings.runtimeManage')}
      </Button>
      {open && <div id={`runtime-${engineId}`} className="engine-runtime-body">
        <div className="engine-runtime-heading">
          <span>{t('settings.runtimeCurrent', { version: catalog?.current_version || t('settings.runtimeNotInstalled') })}</span>
          <Button variant="ghost" loading={loading} disabled={loading || running} onClick={() => void load()}>{t('settings.runtimeRefresh')}</Button>
        </div>
        {loading && !catalog && <p role="status"><Spinner /> {t('settings.runtimeLoading')}</p>}
        {catalog && <>
          <div className="engine-runtime-actions">
            <label htmlFor={`version-${engineId}`}>{t('settings.runtimeSelect')}</label>
            <Select id={`version-${engineId}`} value={version} disabled={blocked || loading || !catalog.versions.length}
              onChange={event => setVersion(event.target.value)}>
              {!version && <option value="">{t('settings.runtimeEmpty')}</option>}
              {catalog.versions.map(item => <option key={item.version} value={item.version}>
                {item.version}{item.prerelease ? ` · ${t('settings.runtimePrerelease')}` : ''}
              </option>)}
            </Select>
            <Button variant="primary" disabled={blocked || loading || !selected || version === catalog.current_version}
              onClick={() => ask('install')}>{t('settings.runtimeInstall')}</Button>
            {catalog.rollback_version && <Button variant="ghost" disabled={blocked || loading} onClick={() => ask('rollback')}>
              {t('settings.runtimeRollback', { version: catalog.rollback_version })}
            </Button>}
          </div>
          <p className="engine-runtime-note">{selected?.size_bytes != null
            ? t('settings.runtimePrimarySize', { size: formatPackageBytes(selected.size_bytes) })
            : t('settings.runtimeSizeUnknown')}<br />{t('settings.runtimeSizeScope')}</p>
          {catalog.configured_path && <p role="alert">{t('settings.runtimeOverride')}</p>}
          {catalog.error && <p role="alert">{catalog.error}</p>}
          {!!catalog.history.length && <details>
            <summary>{t('settings.runtimeHistory')}</summary>
            <ul>{catalog.history.slice().reverse().map((item, index) => <li key={`${item.at}-${index}`}>
              <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>{' · '}
              {item.from_version || t('settings.runtimeNotInstalled')} → {item.to_version}
            </li>)}</ul>
          </details>}
        </>}
        <EngineInstallProgress active={running} completed={operation?.status === 'succeeded'} label={phaseLabel}
          downloadedBytes={operation?.stage === 'downloading' ? operation.downloaded_bytes : undefined}
          totalBytes={operation?.stage === 'downloading' ? operation.total_bytes : undefined} />
        {running && <p className="engine-runtime-note">{t('settings.runtimeContinue')}</p>}
        {operation?.message && <p role={operation.status === 'failed' ? 'alert' : 'status'}>{operation.message}</p>}
        {pollError && <p role="alert">{t('settings.runtimePollingError')}</p>}
        {error && !confirmation && <p role="alert">{error}</p>}
      </div>}
      <ConfirmDialog open={confirmation !== null} width={480}
        title={confirmation === 'rollback' ? t('settings.runtimeConfirmRollback') : t('settings.runtimeConfirmInstall')}
        message={t('settings.runtimeChange', { current: catalog?.current_version || t('settings.runtimeNotInstalled'), target: target || '' })}
        confirmText={confirmation === 'rollback' ? t('settings.runtimeConfirmRollback') : t('settings.runtimeConfirmInstall')}
        confirmDisabled={blocked || !target || Boolean(catalog?.requires_terms && !acceptTerms)} loading={submitting}
        onCancel={() => { if (!submitting) setConfirmation(null) }} onConfirm={() => void submit()}>
        <p>{t('settings.runtimeRestart')}</p>
        {catalog?.requires_terms && <label className="engine-runtime-terms">
          <input type="checkbox" checked={acceptTerms} onChange={event => setAcceptTerms(event.target.checked)} />
          <span>{t('settings.runtimeTerms')}{' '}
            {catalog.terms_url && <a href={catalog.terms_url} target="_blank" rel="noreferrer">{t('settings.reviewThirdPartyTerms')}</a>}
          </span>
        </label>}
        {error && <p role="alert">{error}</p>}
      </ConfirmDialog>
    </div>
  )
}
