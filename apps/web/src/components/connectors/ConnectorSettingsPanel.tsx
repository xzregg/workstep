import { useEffect, useState } from 'react'
import { connectorApi, type Connector, type DiscoveredConnector } from '../../api/connectors'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import ConnectorEditor from './ConnectorEditor'
import './Connectors.css'

type Tab = 'added' | 'browse' | 'local'
function ConnectorMark({ name, kind }: { name: string; kind: string }) {
  const github = /github|^gh$/i.test(name)
  return <span className="connector-mark" data-brand={github ? 'github' : undefined}>
    {github ? 'GH' : <Icon name={kind === 'cli' ? 'terminal' : 'plug'} size={20} />}
  </span>
}

export default function ConnectorSettingsPanel() {
  const { t } = useI18n()
  const [items, setItems] = useState<Connector[]>([])
  const [edit, setEdit] = useState<Partial<Connector> | null>(null)
  const [editorTab, setEditorTab] = useState<'config' | 'test'>('config')
  const [remove, setRemove] = useState<Connector | null>(null)
  const [discoveries, setDiscoveries] = useState<DiscoveredConnector[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('added')
  const load = async () => { setLoading(true); try { setItems((await connectorApi.list()).connectors) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const operation = async (key: string, work: () => Promise<void>) => { setBusy(key); setError(''); try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') } }
  const scan = () => { setTab('local'); setQuery(''); void operation('scan', async () => setDiscoveries((await connectorApi.scan()).items)) }
  const changeTab = (next: Tab) => { setTab(next); setQuery('') }
  const matches = (name: string, description = '') => `${name} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const templates: { name: string; description: string; kind: Connector['kind']; transport: Connector['transport'] }[] = [
    { name: t('connectors.remote'), description: t('connectors.remoteDescription'), kind: 'mcp', transport: 'http' },
    { name: t('connectors.local'), description: t('connectors.localDescription'), kind: 'mcp', transport: 'stdio' },
    { name: 'CLI', description: t('connectors.cliDescription'), kind: 'cli', transport: 'stdio' },
  ]
  const templateCards = <div className="connector-cards">{templates.filter(item => matches(item.name, item.description)).map(item => <article className="connector-card connector-template-card" key={item.transport + item.kind}>
    <header><ConnectorMark name={item.name} kind={item.kind} /><div className="connector-card-identity"><strong>{item.name}</strong><small className="connector-card-kind">{item.kind === 'cli' ? t('connectors.existingLogin') : item.transport === 'http' ? 'HTTP / SSE' : 'stdio'}</small></div></header>
    <p className="connector-card-description">{item.description}</p>
    <footer><small>{t('connectors.visualConfiguration')}</small><Button onClick={() => setEdit({ kind: item.kind, transport: item.transport })}>{t('connectors.addShort')}<Icon name="plus" size={13} /></Button></footer>
  </article>)}</div>
  return <div className="connector-settings">
    <header className="connector-settings-header"><div className="connector-heading"><h2>{t('connectors.title')}</h2><p>{t('connectors.subtitle')}</p></div><div className="connector-header-actions">
      <Button disabled={!!busy} loading={busy === 'scan'} onClick={scan}><Icon name="scan" size={16} />{t('connectors.scan')}</Button>
      <Button variant="primary" onClick={() => setEdit({})}><Icon name="plus" size={16} />{t('connectors.add')}</Button>
    </div></header>
    <div className="connector-tabs" role="tablist" aria-label={t('connectors.title')}>
      {(['added', 'browse', 'local'] as Tab[]).map(id => <button key={id} id={`connector-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="connector-tab-panel" onClick={() => changeTab(id)}>{t(`connectors.tab${id === 'added' ? 'Added' : id === 'browse' ? 'Browse' : 'Local'}`)}{id === 'added' && <span>{items.length}</span>}{id === 'local' && discoveries && <span>{discoveries.length}</span>}</button>)}
    </div>
    {error && <p role="alert" className="connector-error">{error}</p>}
    <div role="tabpanel" id="connector-tab-panel" aria-labelledby={`connector-tab-${tab}`}>
      {tab !== 'local' && <div className="connector-overview-toolbar"><label className="connector-search"><Icon name="search" size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('connectors.search')} aria-label={t('connectors.search')} /></label><span>{t('connectors.autoEngines')}</span></div>}
      {tab === 'added' && <>
        {loading ? <span className="connector-loading"><span className="task-status-spinner" />{t('connectors.loading')}</span> : !items.filter(item => matches(item.name, item.description)).length ? <div className="connector-overview-empty"><span className="connector-mark"><Icon name="plug" size={24} /></span><strong>{query ? t('connectors.noMatches') : t('connectors.empty')}</strong><p>{query ? t('connectors.searchAgain') : t('connectors.emptyHint')}</p>{!query && <Button onClick={() => changeTab('browse')}>{t('connectors.tabBrowse')}<Icon name="arrow-right" size={14} /></Button>}</div> : <div className="connector-cards">{items.filter(item => matches(item.name, item.description)).map(item => <article key={item.id} className="connector-card">
          <header><ConnectorMark name={item.name} kind={item.kind} /><div className="connector-card-identity"><strong>{item.name}</strong><small className="connector-card-kind">{item.kind === 'cli' ? 'CLI' : `${item.transport === 'stdio' ? t('connectors.local') : t('connectors.remote')}`}</small></div><span className="connector-card-state" data-enabled={item.enabled}><i />{item.enabled ? t('connectors.enabled') : t('connectors.disabled')}</span></header>
          <p className="connector-card-description">{item.description || t(item.kind === 'cli' ? 'connectors.cliDescription' : item.transport === 'stdio' ? 'connectors.localDescription' : 'connectors.remoteDescription')}</p>
          <footer><small>{item.project_ids.length ? t('connectors.limitedProjects', { count: item.project_ids.length }) : t('connectors.allProjects')}</small><div className="connector-card-actions">
            <Button variant="icon" title={t('connectors.test')} aria-label={t('connectors.test')} disabled={!!busy} onClick={() => { setEditorTab('test'); setEdit(item) }}><Icon name="refresh" size={14} /></Button>
            <Button variant="icon" title={t('connectors.remove')} aria-label={t('connectors.remove')} onClick={() => setRemove(item)}><Icon name="trash" size={14} /></Button>
            <Button onClick={() => setEdit(item)}>{t('connectors.manageShort')}</Button>
          </div></footer>
        </article>)}</div>}
        <div className="connector-quiet-note"><Icon name="shield" size={16} /><span>{t('connectors.credentialsHint')}</span></div>
        {!query && <section className="connector-more"><div className="connector-section-caption"><span>{t('connectors.discoverMore')}</span><button type="button" onClick={() => changeTab('browse')}>{t('connectors.browseAll')}<Icon name="arrow-right" size={14} /></button></div>{templateCards}</section>}
      </>}
      {tab === 'browse' && templateCards}
      {tab === 'local' && <section className="connector-local-discovery">
        <div className="connector-scan-intro"><span className="connector-mark"><Icon name="scan" size={23} /></span><div><h3>{t(discoveries ? 'connectors.discovered' : 'connectors.scanTitle')}</h3><p>{t('connectors.scanSummary')}</p></div><Button disabled={!!busy} loading={busy === 'scan'} onClick={scan}>{t(discoveries ? 'connectors.rescan' : 'connectors.startScan')}</Button></div>
        {discoveries && <><div className="connector-section-caption"><span>{t('connectors.localResults', { count: discoveries.length })}</span></div><div className="connector-cards">{discoveries.map(item => <article key={item.id} className="connector-card connector-discovery-card">
          <header><ConnectorMark name={item.name} kind={item.kind} /><div className="connector-card-identity"><strong>{item.name}</strong><small className="connector-card-kind">{item.kind === 'cli' ? 'CLI' : 'MCP'}</small></div></header>
          <p className="connector-source" title={item.source}>{item.source}</p>
          <footer><small>{t('connectors.requiresReview')}</small><Button onClick={() => setEdit({ name: item.name, kind: item.kind, transport: item.transport, command: item.command })}>{t('connectors.configure')}</Button></footer>
        </article>)}</div>{!discoveries.length && <div className="connector-overview-empty"><p>{t('connectors.scanEmpty')}</p></div>}</>}
        <p className="connector-local-note"><Icon name="shield" size={15} />{t('connectors.scanHint')}</p>
      </section>}
    </div>
    {edit && <ConnectorEditor initial={edit} initialTab={editorTab} onClose={() => { setEdit(null); setEditorTab('config') }} onSaved={() => { setEdit(null); setEditorTab('config'); setTab('added'); void load() }} />}
    <ConfirmDialog open={!!remove} title={t('connectors.remove')} message={t('connectors.removeHint')} danger loading={busy === 'delete'} onCancel={() => setRemove(null)} onConfirm={() => { if (remove) void operation('delete', async () => { await connectorApi.delete(remove.id); setRemove(null); await load() }) }} />
  </div>
}
