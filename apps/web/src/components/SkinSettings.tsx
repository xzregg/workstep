import ChatMessageBubble from './ChatMessageBubble'
import { ApiError } from '../api/transport'
import { useEffect, useRef, useState } from 'react'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import ConfirmDialog from './ConfirmDialog'
import EngineSelect from './EngineSelect'
import { skinsApi, type SkinSummary, type SkinWorkspace } from '../api/skins'
import { useI18n } from '../i18n'
import { loadDraft, saveDraft } from '../utils/chatDraft'
import SkinStudio from './SkinStudio'
import { useProjectStore } from '../stores/projectStore'
import { useSkinPreviewing, cancelSkinPreview, previewSkin, restoreDefaultSkin, saveSkin, useActiveSkin } from '../skins/runtime'
import { defaultSkin, skinContract, type SkinDocument } from '../skins/contract'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import SkinLibrary from './SkinLibrary'
import Icon from './Icon'
import './SkinSettings.css'

export default function SkinSettings() {
  const { t } = useI18n()
  const active = useActiveSkin(), previewing = useSkinPreviewing()
  const [skins, setSkins] = useState<SkinSummary[]>([])
  const [documents, setDocuments] = useState<SkinDocument[]>([defaultSkin()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [path, setPath] = useState('')
  const [checked, setChecked] = useState<SkinDocument | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [importing, setImporting] = useState<File | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [sampleEngine, setSampleEngine] = useState('demo')
  const [sampleValue, setSampleValue] = useState('one')
  const [workspace, setWorkspace] = useState<(SkinWorkspace & { base?: SkinDocument }) | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const gatewaySession = useGatewaySessionStore(state => state.session)
  const remote = isGatewayRemoteBrowser() && (!gatewaySession || !!gatewaySession.host_project_id)
  const refresh = async () => {
    const result = await skinsApi.list()
    const loaded = await Promise.all(result.filter(item => item.manifest.id !== 'default').map(item => skinsApi.get(item.manifest.id)))
    if (mounted.current) { setSkins(result); setDocuments([defaultSkin(), ...loaded]) }
  }
  useEffect(() => {
    mounted.current = true
    void refresh().catch(err => { if (mounted.current) setError(String(err.message || err)) })
    return () => { mounted.current = false }
  }, [])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const register = async (replace = false) => {
    const skin = await skinsApi.register(path, replace)
    if (mounted.current) { setChecked(skin); setReplacing(false) }
    await refresh()
  }
  const start = (base?: SkinDocument) => run(async () => {
    const result = await skinsApi.onboarding()
    if (result.created !== false && !loadDraft(result.session_id)) saveDraft(result.session_id, t('skins.studioDraft') + (base ? `\n${t('skins.studioEditing')}：${base.manifest.id}-custom` : ''))
    await useProjectStore.getState().fetchProjects()
    if (mounted.current) setWorkspace(base ? { ...result, package_path: `${result.workspace_path}/${base.manifest.id}-custom`, base } : result)
  })
  const exportSkin = (id: string) => run(async () => {
    const blob = await skinsApi.export(id), url = URL.createObjectURL(blob)
    try { const link = document.createElement('a'); link.href = url; link.download = id + '.zip'; link.click() }
    finally { window.setTimeout(() => URL.revokeObjectURL(url), 0) }
  })
  return <div className="skin-settings">
    <header className="skin-settings-page-head"><div><h2>{t('skins.centerTitle')}</h2><p>{t('skins.centerIntro')}</p></div><div className="skin-settings-actions">
      {!remote && <><Button variant="primary" onClick={() => void start()} disabled={busy} loading={busy}><Icon name="sparkles" size={15} />{t('skins.create')}</Button></>}
      <Button variant="icon" onClick={() => void run(refresh)} disabled={busy} aria-label={t('skins.refresh')} title={t('skins.refresh')}><Icon name="refresh" size={16} /></Button>
    </div></header>
    <input ref={fileInput} type="file" accept=".zip,application/zip" className="skin-settings-file" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''
      if (file) void run(async () => {
        try { const skin = await skinsApi.import(file); if (mounted.current) setChecked(skin); await refresh() }
        catch (error) { if (error instanceof ApiError && error.status === 409) { if (mounted.current) setImporting(file) } else throw error }
      })
    }} />
    {error && <p role="alert" className="skin-settings-error">{error}</p>}
    {previewing && <div role="status" className="skin-settings-preview-notice"><span>{t('skins.previewing')}</span><Button onClick={() => saveSkin(active)}>{t('skins.apply')}</Button><Button onClick={cancelSkinPreview}>{t('skins.cancelPreview')}</Button></div>}
    <SkinLibrary toolbarActions={!remote && <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}><Icon name="upload" size={15} />{t('skins.import')}</Button>} documents={documents} activeId={active.manifest.id} preferredSkin={checked} busy={busy} canManage={!remote}
      onCreate={base => void start(base)} onPreview={previewSkin} onApply={saveSkin}
      onExport={id => void exportSkin(id)} onDelete={setDeleting} onRestore={restoreDefaultSkin} />
    <details className="skin-settings-advanced"><summary>{t('skins.advanced')}</summary>
    {!remote && <div className="skin-settings-package"><h2>{t('skins.package')}</h2>
      <Input disabled={busy} value={path} onChange={event => { setPath(event.target.value); setChecked(null) }} placeholder={t('skins.path')} aria-label={t('skins.path')} />
      <div className="skin-settings-actions"><Button disabled={!path.trim() || busy} onClick={() => void run(async () => { const result = await skinsApi.validate(path); if (mounted.current) setChecked(result.skin) })}>{t('skins.validate')}</Button>
        <Button disabled={!path.trim() || busy} onClick={() => void run(async () => {
          const result = await skinsApi.validate(path)
          if (!mounted.current) return
          if (skins.some(s => s.manifest.id === result.skin.manifest.id)) setReplacing(true); else await register()
        })}>{t('skins.register')}</Button>
        {checked && <Button disabled={busy} onClick={() => previewSkin(checked)}>{t('skins.preview')}</Button>}
      </div>
      {checked && <p role="status">{t('skins.checked', { overridden: checked.coverage?.overridden.length ?? 0, inherited: checked.coverage?.inherited.length ?? Object.keys(skinContract.parts).length })}</p>}
    </div>}
    <section className="skin-settings-showcase"><h2>{t('skins.samples')}</h2><p>{t('skins.sampleHint')}</p>
      <div className="skin-settings-actions"><Button variant="primary">{t('skins.sampleButton')}</Button><Button disabled>{t('skins.sampleDisabled')}</Button><Button loading>{t('skins.sampleLoading')}</Button><Button variant="danger">{t('skins.sampleError')}</Button></div>
      <Input placeholder={t('skins.sampleInput')} />
      <Select value={sampleValue} onChange={event => setSampleValue(event.target.value)} aria-label={t('skins.sampleSelect')}><option value="one">{t('skins.sampleOption')}</option><option value="two" disabled>{t('skins.sampleDisabled')}</option></Select>
      <EngineSelect engines={[{ id: 'demo', enabled: true, installed: true, configured: true, verified: true, built_in: false, mode: 'sdk' }, { id: 'unavailable', installed: true, configured: false, verified: false, built_in: false, mode: 'cli' }]} value={sampleEngine} onChange={setSampleEngine} />
      <ChatMessageBubble role="assistant" sender={t('skins.sampleMessage')} initials="AI" color="var(--ai-assistant)" content={t('skins.sampleText')} />
    </section>
    </details>
    <ConfirmDialog open={Boolean(importing)} title={t('skins.replace')} loading={busy} onCancel={() => { if (!busy) setImporting(null) }} onConfirm={() => void run(async () => {
      const skin = await skinsApi.import(importing!, true)
      if (mounted.current) { setChecked(skin); setImporting(null) }
      await refresh()
    })} />
    <ConfirmDialog open={replacing} title={t('skins.replace')} loading={busy} onCancel={() => { if (!busy) setReplacing(false) }} onConfirm={() => void run(() => register(true))} />
    <ConfirmDialog open={Boolean(deleting)} title={t('skins.deleteConfirm')} loading={busy} onCancel={() => { if (!busy) setDeleting(null) }} onConfirm={() => void run(async () => {
      const id = deleting!; await skinsApi.remove(id)
      if (active.manifest.id === id) restoreDefaultSkin()
      if (mounted.current) setDeleting(null)
      await refresh()
    })} />
    {workspace && <SkinStudio workspace={workspace} initialSkin={workspace.base} onClose={() => setWorkspace(null)} onSaved={skin => {
      setChecked(skin); previewSkin(skin); setWorkspace(null); void run(refresh)
    }} />}
  </div>
}
