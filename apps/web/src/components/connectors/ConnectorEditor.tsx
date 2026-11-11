import { useEffect, useMemo, useRef, useState } from 'react'
import { connectorApi, type Connector, type ConnectorWrite } from '../../api/connectors'
import { useProjectStore } from '../../stores/projectStore'
import { useI18n } from '../../i18n'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import Select from '../Select'
import ConnectorArgumentsEditor, { parseArguments } from './ConnectorArgumentsEditor'
import ConnectorTestPanel from './ConnectorTestPanel'

type Pair = { name: string; value: string }
export default function ConnectorEditor({ initial, initialTab = 'config', onClose, onSaved }: { initial?: Partial<Connector>; initialTab?: 'config' | 'test'; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const projects = useProjectStore(state => state.projects)
  const [value, setValue] = useState<ConnectorWrite>({ name: '', kind: 'mcp', transport: 'http', command: '', args: [], url: '', project_ids: [], enabled: true, ...initial })
  const [argsText, setArgsText] = useState(initial?.args?.length ? JSON.stringify(initial.args, null, 2) : '')
  const parsedArgs = parseArguments(argsText)
  const [authMode, setAuthMode] = useState<'keep' | 'none' | 'bearer' | 'custom'>(initial?.header_names?.length ? 'keep' : 'none')
  const [token, setToken] = useState('')
  const [headers, setHeaders] = useState<Pair[]>([])
  const [env, setEnv] = useState<Pair[]>([])
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState(initialTab)
  const [testing, setTesting] = useState(false)
  const authRef = useRef<HTMLFieldSetElement>(null)
  const focusAuth = useRef(false)
  useEffect(() => {
    if (tab === 'config' && focusAuth.current) {
      focusAuth.current = false
      authRef.current?.querySelector<HTMLSelectElement>('select')?.focus()
      authRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [tab])
  const change = (patch: Partial<ConnectorWrite>) => { setDirty(true); setValue(current => ({ ...current, ...patch })) }
  const projectOptions = [...projects.map(p => ({ id: p.id, name: p.name })),
    ...(value.project_ids || []).filter(id => !projects.some(p => p.id === id)).map(id => ({ id, name: id }))]
  const remote = value.kind === 'mcp' && value.transport !== 'stdio'
  const authValid = !remote || authMode === 'keep' || authMode === 'none' || (authMode === 'bearer' ? Boolean(token.trim()) && !/[\r\n]/.test(token) : headers.length > 0 && headers.every(pair => pair.name.trim() && pair.value.trim()))
  const valid = authValid && Boolean(value.name.trim() && (remote ? /^https?:\/\//.test(value.url || '') : value.command?.trim() && parsedArgs !== null))
  const definition = useMemo<ConnectorWrite>(() => ({ ...value, args: parsedArgs ?? value.args ?? [],
    ...(remote ? authMode === 'none' ? { headers: {} } : authMode === 'bearer' ? { headers: { Authorization: `Bearer ${token.trim()}` } } : authMode === 'custom' ? { headers: Object.fromEntries(headers.map(pair => [pair.name.trim(), pair.value])) } : {} : {}),
    ...(env.length ? { env: Object.fromEntries(env.filter(pair => pair.name.trim()).map(pair => [pair.name.trim(), pair.value])) } : {}),
  }), [value, argsText, remote, authMode, token, headers, env])
  const save = async () => {
    setSaving(true); setError('')
    try {
      await connectorApi.save(definition); onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  const pairs = (label: string, entries: Pair[], set: (entries: Pair[]) => void) => <fieldset className="connector-pairs"><legend>{label}</legend>
    {entries.map((entry, index) => <div key={index}><input aria-label={t('connectors.key')} placeholder={t('connectors.key')} value={entry.name} onChange={e => { setDirty(true); set(entries.map((p, i) => i === index ? { ...p, name: e.target.value } : p)) }} />
      <input type="password" autoComplete="off" aria-label={t('connectors.secret')} placeholder={t('connectors.secret')} value={entry.value} onChange={e => { setDirty(true); set(entries.map((p, i) => i === index ? { ...p, value: e.target.value } : p)) }} />
      <button type="button" className="connector-icon" aria-label={t('connectors.removeField')} onClick={() => { setDirty(true); set(entries.filter((_, i) => i !== index)) }}><Icon name="x" size={16} /></button></div>)}
    <button type="button" onClick={() => { setDirty(true); set([...entries, { name: '', value: '' }]) }}>{t('connectors.addField')}</button>
  </fieldset>
  return <>
    <ConfirmDialog open title={initial?.id ? t('connectors.edit') : t('connectors.add')} width={760} loading={saving} confirmDisabled={!valid || saving || testing}
      confirmText={t('connectors.save')} onConfirm={() => void save()} onCancel={() => { if (!saving) dirty ? setDiscard(true) : onClose() }}>
      <div className="connector-editor-tabs" role="tablist" aria-label={t('connectors.edit')}>
        {(['config', 'test'] as const).map(id => <button key={id} type="button" role="tab" data-connector-tab={id} aria-selected={tab === id} disabled={saving} onClick={() => setTab(id)}>{t(id === 'config' ? 'connectors.configuration' : 'connectors.testTab')}</button>)}
      </div>
      {tab === 'config' && <div className="connector-editor connector-editor--visual">
        <label>{t('connectors.name')}<input value={value.name} placeholder={t('connectors.nameExample')} onChange={e => change({ name: e.target.value })} /></label>
        <label>{t('connectors.description')}<input value={value.description || ''} placeholder={t('connectors.descriptionExample')} onChange={e => change({ description: e.target.value })} /></label>
        <fieldset className="connector-connection"><legend>{t('connectors.connection')}</legend>
          <div className="connector-connection-modes" role="group" aria-label={t('connectors.type')}>
            {(['remote', 'local', 'cli'] as const).map(mode => <button key={mode} type="button" data-connector-mode={mode} aria-pressed={mode === 'remote' ? remote : mode === 'local' ? value.kind === 'mcp' && !remote : value.kind === 'cli'}
              onClick={() => change({ kind: mode === 'cli' ? 'cli' : 'mcp', transport: mode === 'remote' ? value.transport === 'sse' ? 'sse' : 'http' : 'stdio' })}>
              <Icon name={mode === 'cli' ? 'terminal' : mode === 'local' ? 'monitor' : 'plug'} size={14} />{mode === 'cli' ? 'CLI' : t(mode === 'remote' ? 'connectors.serverUrl' : 'connectors.local')}
            </button>)}
          </div>
          {remote ? <label className="connector-field"><span>{t('connectors.url')}</span><input type="url" value={value.url} onChange={e => change({ url: e.target.value })} placeholder="https://example.com/mcp" /></label> : <div className="connector-local-fields">
            <label className="connector-field"><span>{t('connectors.command')}</span><input className="connector-command-input" value={value.command} onChange={e => change({ command: e.target.value })} placeholder="npx / dws / gh" /></label>
            <ConnectorArgumentsEditor text={argsText} cli={value.kind === 'cli'} onChange={text => { setDirty(true); setArgsText(text) }} />
          </div>}
        </fieldset>
        {remote && <fieldset ref={authRef} className="connector-authentication"><legend>{t('connectors.authentication')}</legend>
          <Select className="connector-auth-select" aria-label={t('connectors.authentication')} value={authMode} onChange={e => { setDirty(true); setAuthMode(e.target.value as typeof authMode) }}>
            {value.has_credentials && initial?.header_names?.length ? <option value="keep">{t('connectors.keepAuthentication')}</option> : null}
            <option value="none">{t('connectors.noAuthentication')}</option><option value="bearer">{t('connectors.bearerAuthentication')}</option><option value="custom">{t('connectors.headers')}</option>
          </Select>
          {authMode === 'bearer' && <label className="connector-field connector-token-field"><span>Access Token</span><input className="connector-token-input" type="password" autoComplete="off" value={token} placeholder={t('connectors.tokenExample')} onChange={e => { setDirty(true); setToken(e.target.value) }} /></label>}
          {authMode === 'keep' && <p className="connector-muted">{t('connectors.keepSecrets')}</p>}
          {authMode === 'custom' && pairs(t('connectors.headers'), headers, setHeaders)}
        </fieldset>}
        <details className="connector-advanced"><summary><Icon name="settings" size={15} /><span>{t('connectors.advanced')}</span><Icon name="chevron-down" size={14} /></summary><div className="connector-advanced-content">
          {remote ? <label className="connector-field"><span>{t('connectors.protocol')}</span><Select value={value.transport} onChange={e => change({ transport: e.target.value as Connector['transport'] })}><option value="http">Streamable HTTP</option><option value="sse">SSE</option></Select></label> : pairs(t('connectors.env'), env, setEnv)}
          {value.kind === 'cli' && <p className="connector-muted">{t('connectors.loginHint')}</p>}
          <p className="connector-muted">{t('connectors.localSecrets')}</p>
          {value.has_credentials && <button type="button" onClick={() => { change({ headers: {}, env: {}, has_credentials: false }); setHeaders([]); setEnv([]); setAuthMode('none'); setToken('') }}>{t('connectors.clearCredentials')}</button>}
        </div></details>
        <fieldset className="connector-projects"><legend>{t('connectors.projects')}</legend>
          <Select multiple value={value.project_ids || []} aria-label={t('connectors.projects')} title={t('connectors.allProjectsHint')}
            onChange={e => change({ project_ids: Array.from(e.target.options).filter(option => option.selected).map(option => option.value) })}>
            {projectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          {!!value.project_ids?.length && <div className="connector-project-tags">
            {value.project_ids.map(id => <button key={id} type="button" className="connector-project-tag" aria-label={`${t('connectors.removeField')} ${projectOptions.find(p => p.id === id)?.name || id}`}
              onClick={() => change({ project_ids: value.project_ids?.filter(selected => selected !== id) })}>
              <span>{projectOptions.find(p => p.id === id)?.name || id}</span><Icon name="x" size={12} />
            </button>)}
          </div>}
          <p className="connector-muted connector-project-hint">{t('connectors.allProjectsHint')}</p>
        </fieldset>
        <label className="connector-checkbox"><input type="checkbox" checked={value.enabled} onChange={e => change({ enabled: e.target.checked })} />{t('connectors.enabled')}</label>
        <p className="connector-error" role="alert">{error}</p>
      </div>}
      <ConnectorTestPanel definition={definition} valid={valid} active={tab === 'test'} onBusyChange={setTesting}
        onConfigureAuth={() => { focusAuth.current = true; setTab('config') }} />
    </ConfirmDialog>
    <ConfirmDialog open={discard} title={t('connectors.discard')} onConfirm={onClose} onCancel={() => setDiscard(false)} zIndex={2100} />
  </>
}
