import { useCallback, useEffect, useRef, useState } from 'react'
import { decisionModelsApi as api, decisionResourceBusy, validDecisionEndpoint, type DecisionDraft, type DecisionMode, type DecisionResourceKind, type DecisionStatus } from '../api/decisionModels'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import Icon from '../components/Icon'
import Spinner from '../components/Spinner'
import DecisionModelResource from '../components/DecisionModelResource'
import DecisionServiceModels from '../components/DecisionServiceModels'
import DecisionProxySettings from '../components/DecisionProxySettings'
import { useI18n, type TKey } from '../i18n'
import './DecisionModelSettings.css'

type ExternalDraft = { base_url: string; model: string; api_key: string | null }
type Form = { managed_model: string; proxy_enabled: boolean; access_key: string; mode: DecisionMode; local: ExternalDraft; remote: ExternalDraft }
const blank = (): ExternalDraft => ({ base_url: '', model: '', api_key: null })
function formFrom(status: DecisionStatus): Form {
  const form: Form = { managed_model: status.settings.managed_model ?? 'laya-multilingual', proxy_enabled: status.settings.proxy_enabled ?? false, access_key: '', mode: status.settings.mode, local: blank(), remote: blank() }
  if (form.mode !== 'managed') form[form.mode] = { base_url: status.settings.base_url, model: status.settings.model, api_key: null }
  return form
}
function valid(draft: DecisionDraft) {
  if (draft.mode === 'managed') return true
  return validDecisionEndpoint(draft.base_url) && Boolean(draft.model.trim())
}
export default function DecisionModelSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<DecisionStatus | null>(null)
  const [form, setForm] = useState<Form>({ managed_model: 'laya-multilingual', proxy_enabled: false, access_key: '', mode: 'managed', local: blank(), remote: blank() })
  const [saved, setSaved] = useState<Form | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<number | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [deleting, setDeleting] = useState<DecisionResourceKind | null>(null)
  const mounted = useRef(true)
  const request = useRef<AbortController | null>(null)
  const initialize = useCallback(async () => {
    try { const value = await api.status(); if (mounted.current) { setStatus(value); const initial = formFrom(value); setForm(initial); setSaved(initial); setError('') } }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : t('decisionModels.loadFailed')) }
  }, [t])
  useEffect(() => { mounted.current = true; void initialize(); return () => { mounted.current = false; request.current?.abort() } }, [initialize])
  const dirty = saved !== null && JSON.stringify(form) !== JSON.stringify(saved)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const installing = status != null && Object.values(status.resources).some(decisionResourceBusy)
  useEffect(() => {
    if (!installing) return
    let cancelled = false; let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const next = await api.status(); if (!cancelled) setStatus(next) }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : t('decisionModels.loadFailed')) }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [installing, t])
  const draft: DecisionDraft = form.mode === 'managed' ? { mode: 'managed', base_url: '', model: '', api_key: '' } : { mode: form.mode, ...form[form.mode] }
  draft.managed_model = form.managed_model
  draft.proxy_enabled = form.proxy_enabled
  draft.access_key = form.access_key
  const selectedEnvironment = status?.models?.find(model => model.id === form.managed_model)?.environment ?? status?.environment
  const managedSupported = selectedEnvironment?.supported === true
  const managedAvailable = status?.models?.some(model => model.environment?.supported) || managedSupported
  const validDraft = valid(draft) && !(form.mode === 'managed' && form.proxy_enabled && !status?.proxy?.access_key_set && !form.access_key.trim()) && !(form.mode === 'managed' && form.proxy_enabled && !managedSupported)
  const patch = (values: Partial<ExternalDraft>) => { if (form.mode === 'managed') return; setForm({ ...form, [form.mode]: { ...form[form.mode], ...values } }); setResult(null) }
  const mutate = async (name: string, action: () => Promise<DecisionStatus>) => {
    setBusy(name); setError(''); setResult(null)
    try { const next = await action(); if (mounted.current) setStatus(next); return next }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); return null }
    finally { if (mounted.current) setBusy('') }
  }
  const save = async () => {
    const next = await mutate('save', () => api.save(draft))
    if (next && mounted.current) { const clean: Form = { ...form, access_key: '', ...(form.mode === 'managed' ? {} : { [form.mode]: { base_url: next.settings.base_url, model: next.settings.model, api_key: null } }) }; setForm(clean); setSaved(clean) }
  }
  const test = async () => {
    setBusy('test'); setError(''); setResult(null); const controller = new AbortController(); request.current = controller
    try { const value = await api.test(draft, controller.signal); if (mounted.current) { setResult(value.elapsed_ms); const next = await api.status(); if (mounted.current) setStatus(next) } }
    catch (e) { if (mounted.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setBusy('') }
  }
  if (!status) return <div className="decision-settings">{error ? <><p role="alert">{error}</p><Button onClick={() => void initialize()}>{t('common.retry')}</Button></> : <Spinner />}</div>
  const models = status.models ?? [{ id: 'laya-multilingual', resource_kind: 'model' as const, name: t('decisionModels.modelName'), description: t('decisionModels.modelHint'), size_bytes: status.resources.model.size_bytes ?? 0 }]
  const selectedModel = models.find(model => model.id === form.managed_model) ?? models[0]
  const ready = Boolean(status.resources[selectedModel.runtime_kind ?? 'runtime']?.installed) && Boolean(status.resources[selectedModel.resource_kind]?.installed)
  const hasKey = status.settings.has_api_key && status.settings.mode === form.mode && status.settings.base_url === draft.base_url
  return <div className="decision-settings">
    <header className="decision-heading"><h1>{t('decisionModels.title')}</h1><span className="decision-badge">{t('decisionModels.compatible')}</span></header>
    <p className="decision-intro">{t('decisionModels.intro')}</p>
    <section className="decision-environment" aria-label={t('decisionModels.environmentTitle')}>
      <div className="decision-environment-heading"><strong>{t(managedSupported ? 'decisionModels.environmentReady' : 'decisionModels.environmentUnavailable')}</strong><Button size="sm" disabled={Boolean(busy)} loading={busy === 'refresh'} onClick={() => void mutate('refresh', api.status)}>{t('decisionModels.environmentRefresh')}</Button></div>
      <p>{t('decisionModels.environmentRequirements')}</p>
      {selectedEnvironment?.cpu_cores != null && <p>{t('decisionModels.environmentDetected', { cpu: selectedEnvironment.cpu_cores, memory: ((selectedEnvironment.memory_total_bytes ?? 0) / 1024 ** 3).toFixed(1), available: ((selectedEnvironment.memory_available_bytes ?? 0) / 1024 ** 3).toFixed(1), disk: ((selectedEnvironment.disk_free_bytes ?? 0) / 1024 ** 3).toFixed(1) })}</p>}
      {!managedSupported && <p className="decision-error">{selectedEnvironment?.reasons.join('；') || t('decisionModels.environmentUnknown')}</p>}
    </section>
    <fieldset className="decision-modes"><legend>{t('decisionModels.mode')}</legend>{(['managed', 'local', 'remote'] as const).map(mode => <button className="decision-mode-option" key={mode} type="button" role="radio" aria-checked={form.mode === mode}
      disabled={Boolean(busy) || (mode === 'managed' && !managedAvailable)} onClick={() => { setForm({ ...form, mode }); setShowKey(false); setResult(null); setError('') }}>
      <span className="decision-radio" /><span><strong>{t(`decisionModels.${mode}` as TKey)}</strong><small>{t(`decisionModels.${mode}Hint` as TKey)}</small></span></button>)}</fieldset>
    {form.mode === 'managed' ? <>
      <section className="decision-block"><div className="decision-block-head"><div><h2>{t('decisionModels.resources')}</h2><p>{t('decisionModels.resourcesHint')}</p></div><span className="decision-badge">{status.platform}</span></div>
        <div className="decision-resource-list" role="region" aria-label={t('decisionModels.resources')} tabIndex={0}>
        {(['runtime', ...(status.resources['runtime-gguf'] ? ['runtime-gguf'] : []), ...models.map(model => model.resource_kind)] as DecisionResourceKind[]).map(kind => {
          const resource = status.resources[kind]
          const model = models.find(item => item.resource_kind === kind)
          const runtimeSupported = models.some(item => (item.runtime_kind ?? 'runtime') === kind && (item.environment?.supported ?? managedSupported))
          return resource && <DecisionModelResource key={kind} kind={kind} resource={resource} model={model} selected={model?.id === form.managed_model}
            onSelect={model ? () => { setForm({ ...form, managed_model: model.id }); setResult(null) } : undefined}
            downloadDisabled={model ? !(model.environment?.supported ?? managedSupported) : !runtimeSupported} selectDisabled={model ? !(model.environment?.supported ?? managedSupported) : false} disabled={Boolean(busy) || (installing && !decisionResourceBusy(resource))}
            onDownload={() => void mutate('download', () => api.download(kind))}
            onCancel={() => void mutate('cancel', () => api.cancel(kind))} onDelete={() => setDeleting(kind)} />
        })}
        </div>
        <p className="decision-catalog-hint">{t('decisionModels.catalogHint')}</p>
      </section><p className="decision-hint">{t('decisionModels.downloadHint')}</p>
      <section className="decision-block"><div className="decision-connection"><div><h2>{t('decisionModels.inference')} <span className="decision-badge" data-state={status.worker}>{t(`decisionModels.${!ready ? 'notReady' : busy === 'test' ? 'loading' : status.worker}` as TKey)}</span></h2><p>{t('decisionModels.inferenceHint')}</p></div>
        <div className="decision-connection-actions">{status.worker === 'ready' && <Button disabled={Boolean(busy)} onClick={() => void mutate('release', api.release)}>{t('decisionModels.release')}</Button>}
          <Button disabled={Boolean(busy) || !ready || installing || !managedSupported} loading={busy === 'test'} onClick={() => void test()}>{t('decisionModels.testLocal')}</Button></div></div>
        <div className="decision-storage"><span>{t('decisionModels.storage')}</span><code>{status.root}</code></div></section>
      {status.proxy && <DecisionProxySettings proxy={status.proxy} enabled={form.proxy_enabled} accessKey={form.access_key} disabled={Boolean(busy)} enableDisabled={!managedSupported} onChange={(enabled, key) => setForm({ ...form, proxy_enabled: enabled, access_key: key })} />}
    </> : <>
      <section className="decision-block"><div className="decision-block-head"><h2>{t(`decisionModels.${form.mode}` as TKey)}</h2><span className="decision-badge">systemone</span></div>
        <div className="decision-form"><label>{t('decisionModels.preset')}<select disabled={Boolean(busy)} value={draft.base_url === 'https://api.typesafe.ai' ? 'typesafe' : 'custom'} onChange={e => patch(e.target.value === 'typesafe' ? { base_url: 'https://api.typesafe.ai', model: 'jev-latest', api_key: '' } : { base_url: '', model: '', api_key: '' })}>
          <option value="custom">{t('decisionModels.custom')}</option>{form.mode === 'remote' && <option value="typesafe">TypeSafe Jev</option>}</select></label>
          <label htmlFor="decision-endpoint">{t('decisionModels.endpoint')} *<input id="decision-endpoint" disabled={Boolean(busy)} type="url" value={draft.base_url} autoComplete="off" placeholder={form.mode === 'local' ? 'http://127.0.0.1:6000' : 'https://your-service.example'} onChange={e => patch({ base_url: e.target.value })} /></label><p>{t('decisionModels.urlHint')}</p>
          <div className="decision-form-row"><label htmlFor="decision-model">{t('decisionModels.model')} *<input id="decision-model" disabled={Boolean(busy)} value={draft.model} autoComplete="off" placeholder={form.mode === 'local' ? 'multilingual' : 'jev-latest'} onChange={e => patch({ model: e.target.value })} /></label>
            <label htmlFor="decision-key">{t('decisionModels.key')}<span className="decision-key"><input id="decision-key" disabled={Boolean(busy)} type={showKey ? 'text' : 'password'} autoComplete="off" value={draft.api_key ?? ''} placeholder={hasKey && draft.api_key === null ? t('decisionModels.keepKey') : ''} onChange={e => patch({ api_key: e.target.value || null })} /><Button variant="icon" aria-label={t('decisionModels.showKey')} onClick={() => setShowKey(!showKey)}><Icon name="eye" size={16} /></Button></span></label></div>
          <DecisionServiceModels source={{ mode: form.mode, base_url: draft.base_url, api_key: draft.api_key }} value={draft.model} disabled={Boolean(busy)} onSelect={model => patch({ model })} />
          {hasKey && <Button size="sm" disabled={Boolean(busy)} onClick={() => patch({ api_key: '' })}>{t(draft.api_key === '' ? 'decisionModels.secretRemoved' : 'decisionModels.clearKey')}</Button>}
          <p>{t('decisionModels.keyNotice')}</p>{!validDraft && (draft.base_url || draft.model) && <p className="decision-error">{t('decisionModels.fieldError')}</p>}
        </div><div className="decision-test-row"><Button disabled={Boolean(busy) || !validDraft} loading={busy === 'test'} onClick={() => void test()}>{t('decisionModels.test')}</Button></div>
      </section><p className="decision-hint">{t('decisionModels.hostHint')}</p><p className="decision-hint">{t('decisionModels.externalHint')}</p>
    </>}
    {error && <p role="alert" className="decision-error">{error}</p>}{result !== null && <p role="status" className="decision-success">{t('decisionModels.testSuccess', { ms: result })}</p>}
    <p className="decision-hint">{t('decisionModels.noScenes')}</p>
    <footer className="decision-footer"><span>{t(dirty ? 'decisionModels.unsaved' : 'decisionModels.saved')}</span><div><Button disabled={Boolean(busy) || !dirty} onClick={() => { if (saved) setForm(saved); setError(''); setResult(null) }}>{t('decisionModels.revert')}</Button><Button variant="primary" disabled={Boolean(busy) || !validDraft} loading={busy === 'save'} onClick={() => void save()}>{t('decisionModels.save')}</Button></div></footer>
    <ConfirmDialog open={deleting !== null} title={t('decisionModels.deleteTitle', { resource: deleting === 'runtime-gguf' ? t('decisionModels.nativeRuntime') : deleting === 'runtime' ? t('decisionModels.runtime') : models.find(model => model.resource_kind === deleting)?.name ?? t('decisionModels.modelName') })} message={t('decisionModels.deleteHint')} danger onCancel={() => setDeleting(null)} onConfirm={() => { const kind = deleting; setDeleting(null); if (kind) void mutate('delete', () => api.delete(kind)) }} />
  </div>
}
