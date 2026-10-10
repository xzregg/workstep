import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { workflowHooksApi, buildHookUrl, type HookConfiguration, type WorkflowHook } from '../api/workflowHooks'
import { useI18n } from '../i18n'
import { copyText } from '../utils/clipboard'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import ResizablePanel from './ResizablePanel'
import './WorkflowHooksDialog.css'
import WorkflowHookTypeTabs from './WorkflowHookTypeTabs'
import './NotificationHooksDialog.css'

interface Props { projectId: string; workflowId: string; workflowName: string; onClose: () => void; onSwitchType?: () => void }
export default function WorkflowHooksDialog({ projectId, workflowId, workflowName, onClose, onSwitchType }: Props) {
  const { t } = useI18n()
  const [config, setConfig] = useState<HookConfiguration | null>(null)
  const [hooks, setHooks] = useState<WorkflowHook[]>([])
  const [initial, setInitial] = useState('[]')
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<'config' | 'simulate'>('config')
  const [busy, setBusy] = useState<'load' | 'save' | ''>('load')
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [confirm, setConfirm] = useState<'close' | 'switch' | 'delete' | 'reset' | ''>('')
  const [showToken, setShowToken] = useState(false)
  const [simulation, setSimulation] = useState({ title: '', creator: '', body: '{\n  "action": "closed",\n  "merged": true\n}', address: '', done: false })
  const dirty = JSON.stringify(hooks) !== initial
  const hook = hooks[selected]
  const invalid = hooks.some(h => !h.name.trim() || !h.default_title.trim() || h.name.length > 128 || h.default_title.length > 500 || h.default_creator.length > 256)

  useEffect(() => {
    let cancelled = false
    setBusy('load'); setFailed(false)
    void workflowHooksApi.get(projectId, workflowId).then(data => {
      if (cancelled) return
      setConfig(data); setHooks(data.hooks); setInitial(JSON.stringify(data.hooks)); setNotice('')
    }).catch(error => { if (!cancelled) { setFailed(true); setNotice(error instanceof Error ? error.message : String(error)) } })
      .finally(() => { if (!cancelled) setBusy('') })
    return () => { cancelled = true }
  }, [projectId, workflowId, reload])

  const close = () => { if (busy) return; if (dirty) setConfirm('close'); else onClose() }
  const change = (patch: Partial<WorkflowHook>) => { setHooks(current => current.map((h, i) => i === selected ? { ...h, ...patch } : h)); setNotice('') }
  const choose = (index: number) => { setSelected(index); setShowToken(false); setSimulation(s => ({ ...s, title: '', creator: '', done: false })) }
  const save = async () => {
    if (invalid || !config || busy || failed) return
    setBusy('save'); setNotice('')
    try {
      const data = await workflowHooksApi.save(projectId, workflowId, hooks)
      setConfig(data); setHooks(data.hooks); setInitial(JSON.stringify(data.hooks)); setNotice(t('workflowHooks.saved'))
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy('') }
  }
  const copy = async (text: string) => setNotice(await copyText(text) ? t('common.copied') : t('workflowHooks.copyFailed'))
  const base = config?.addresses.find(a => a.base_url === simulation.address)?.base_url || config?.addresses[0]?.base_url || ''
  const url = hook && config && base ? buildHookUrl(base, config.device_id, hook, simulation) : ''
  const ready = !!hook?.id && !!hook.token && !hook.rotate_token && !dirty
  const confirmation = () => {
    if (confirm === 'close') onClose()
    if (confirm === 'switch') onSwitchType?.()
    if (confirm === 'delete') { setHooks(current => current.filter((_, i) => i !== selected)); choose(Math.max(0, selected - 1)) }
    if (confirm === 'reset') change({ rotate_token: true })
    setConfirm('')
  }
  const label = (kind: HookConfiguration['addresses'][number]['kind']) => t(`workflowHooks.${kind}`)

  return createPortal(<div className="workflow-hooks-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <ResizablePanel className="workflow-hooks-dialog" role="dialog" aria-modal="true" aria-label={t('workflowHooks.title')} minWidth={650} minHeight={480}>
      <header className="workflow-hooks-header"><strong>{t('workflowHooks.title')} · {workflowName}</strong><Button onClick={close} disabled={!!busy}>{t('workflowHooks.close')}</Button></header>
      <WorkflowHookTypeTabs kind="trigger" disabled={!!busy} onSwitch={() => { if (dirty) setConfirm('switch'); else onSwitchType?.() }} />
      <nav className="workflow-hooks-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'config'} onClick={() => setTab('config')}>{t('workflowHooks.config')}</button>
        <button role="tab" aria-selected={tab === 'simulate'} onClick={() => setTab('simulate')}>{t('workflowHooks.simulation')}</button>
      </nav>
      <div className="workflow-hooks-content">
        {!!busy && <div className="workflow-hooks-loading"><Icon name="loader-circle" className="git-spin" size={20} />{t('workflowHooks.processing')}</div>}
        {failed && <Button onClick={() => setReload(n => n + 1)}>{t('workflowHooks.retry')}</Button>}
        {config && !failed && tab === 'config' && <div className="workflow-hooks-layout">
          <aside className="workflow-hooks-list">
            {hooks.map((h, i) => <button key={h.id || `draft-${i}`} className={i === selected ? 'active' : ''} onClick={() => choose(i)} disabled={!!busy}><strong>{h.name || t('workflowHooks.unnamed')}</strong><small>{config.steps.find(s => s.key === h.step_key)?.name || t('workflowHooks.firstStep')} · {t(h.enabled ? 'workflowHooks.enabled' : 'workflowHooks.disabled')}</small></button>)}
            <Button disabled={!!busy || hooks.length >= 100} onClick={() => { setHooks(current => [...current, { name: t('workflowHooks.newHook'), enabled: true, step_key: '', default_title: t('workflowHooks.defaultTitleValue'), default_creator: t('workflowHooks.defaultCreatorValue'), execution_mode: 'manual' }]); choose(hooks.length) }}>{t('workflowHooks.add')}</Button>
          </aside>
          {hook ? <fieldset className="workflow-hooks-editor" disabled={!!busy}>
            <label>{t('workflowHooks.name')}<input value={hook.name} maxLength={128} onChange={e => change({ name: e.target.value })} /></label>
            <label className="workflow-hooks-checkbox"><input type="checkbox" checked={hook.enabled} onChange={e => change({ enabled: e.target.checked })} />{t('workflowHooks.enabled')}</label>
            <div className="workflow-hooks-fields">
              <label>{t('workflowHooks.defaultTitle')}<input value={hook.default_title} maxLength={500} onChange={e => change({ default_title: e.target.value })} /></label>
              <label>{t('workflowHooks.defaultCreator')}<input value={hook.default_creator} maxLength={256} onChange={e => change({ default_creator: e.target.value })} /></label>
              <label>{t('workflowHooks.step')}<select value={hook.step_key} onChange={e => change({ step_key: e.target.value })}><option value="">{t('workflowHooks.firstStep')}</option>{config.steps.map(s => <option key={s.key} value={s.key}>{s.name} · {s.key}</option>)}</select></label>
              <label>{t('workflowHooks.mode')}<select value={hook.execution_mode} onChange={e => change({ execution_mode: e.target.value as WorkflowHook['execution_mode'] })}><option value="manual">{t('workflowHooks.manual')}</option><option value="immediate">{t('workflowHooks.immediate')}</option></select></label>
            </div>
            <p className="workflow-hooks-hint">{t('workflowHooks.parameterHint')}</p>
            <label>Token<div className="workflow-hooks-token"><input readOnly type={showToken ? 'text' : 'password'} value={hook.rotate_token ? t('workflowHooks.pendingReset') : hook.token || t('workflowHooks.pendingSave')} /><Button onClick={() => setShowToken(!showToken)}>{t(showToken ? 'workflowHooks.hide' : 'workflowHooks.show')}</Button><Button onClick={() => setConfirm('reset')} disabled={!hook.id || hook.rotate_token}>{t('workflowHooks.reset')}</Button></div></label>
            <h3>{t('workflowHooks.addresses')}</h3><p className="workflow-hooks-hint">{t('workflowHooks.addressHint')}</p>
            {!ready && <p className="workflow-hooks-hint">{t('workflowHooks.saveFirst')}</p>}
            {ready && config.addresses.map(a => <div className="workflow-hooks-address" data-testid="hook-address" key={a.kind}><div><strong>{label(a.kind)}</strong><Button onClick={() => void copy(buildHookUrl(a.base_url, config.device_id, hook))}>{t('workflowHooks.copy')}</Button></div><code>{buildHookUrl(a.base_url, config.device_id, hook)}</code>{a.kind === 'gateway' && <small>{t(config.gateway_online ? 'workflowHooks.online' : 'workflowHooks.offline')}</small>}</div>)}
            {!config.addresses.length && <p>{t('workflowHooks.noAddress')}</p>}
            <Button onClick={() => setConfirm('delete')}>{t('workflowHooks.delete')}</Button>
          </fieldset> : <p>{t('workflowHooks.empty')}</p>}
        </div>}
        {config && !failed && tab === 'simulate' && <div className="workflow-hooks-simulation">
          <div className="workflow-hooks-fields"><label>{t('workflowHooks.selectHook')}<select value={selected} onChange={e => choose(Number(e.target.value))}>{hooks.map((h, i) => <option key={i} value={i}>{h.name}</option>)}</select></label><label>{t('workflowHooks.addresses')}<select value={base} onChange={e => setSimulation(s => ({ ...s, address: e.target.value, done: false }))}>{config.addresses.map(a => <option key={a.kind} value={a.base_url}>{label(a.kind)}</option>)}</select></label>
          <label>{t('workflowHooks.overrideTitle')}<input data-testid="hook-title-override" value={simulation.title} placeholder={hook?.default_title} onChange={e => setSimulation(s => ({ ...s, title: e.target.value, done: false }))} /></label><label>{t('workflowHooks.overrideCreator')}<input value={simulation.creator} placeholder={hook?.default_creator || t('workflowHooks.defaultCreatorValue')} onChange={e => setSimulation(s => ({ ...s, creator: e.target.value, done: false }))} /></label></div>
          <p className="workflow-hooks-hint">{t('workflowHooks.simulationHint')}</p>
          <label>{t('workflowHooks.body')}<textarea value={simulation.body} onChange={e => setSimulation(s => ({ ...s, body: e.target.value, done: false }))} /></label>
          {ready && url ? <div className="workflow-hooks-address"><code>{url}</code><Button onClick={() => void copy(url)}>{t('workflowHooks.copy')}</Button></div> : <p>{t('workflowHooks.saveFirst')}</p>}
          <Button variant="primary" disabled={!ready || !hook?.enabled || !url || !!busy} onClick={() => setSimulation(s => ({ ...s, done: true }))}>{t('workflowHooks.simulate')}</Button>
          {hook && <section className="workflow-hooks-preview"><h3>{t(simulation.done ? 'workflowHooks.simulated' : 'workflowHooks.preview')}</h3><strong>{simulation.title.trim() || hook.default_title}</strong><p>{t('workflowHooks.creator')}{simulation.creator.trim() || hook.default_creator.trim() || t('workflowHooks.defaultCreatorValue')}</p><p>{t('workflowHooks.step')}: {config.steps.find(s => s.key === hook.step_key)?.name || config.steps[0]?.name || t('workflowHooks.firstStep')} · {t(hook.execution_mode === 'manual' ? 'workflowHooks.manual' : 'workflowHooks.immediate')}</p><pre>{simulation.body}</pre></section>}
        </div>}
      </div>
      <footer className="workflow-hooks-footer"><span role="status">{notice || (invalid ? t('workflowHooks.required') : '')}</span>{tab === 'config' && <Button variant="primary" disabled={!!busy || failed || !config || invalid || !dirty} onClick={() => void save()}>{t('workflowHooks.save')}</Button>}</footer>
    </ResizablePanel>
    <ConfirmDialog open={!!confirm} title={t('workflowHooks.title')} message={t(confirm === 'close' || confirm === 'switch' ? 'workflowHooks.unsaved' : confirm === 'delete' ? 'workflowHooks.deleteConfirm' : 'workflowHooks.resetConfirm')} confirmText={t('workflowHooks.confirm')} onCancel={() => setConfirm('')} onConfirm={confirmation} />
  </div>, document.body)
}
