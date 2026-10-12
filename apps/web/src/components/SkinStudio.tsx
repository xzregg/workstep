import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { skinsApi, type SkinWorkspace } from '../api/skins'
import type { Project } from '../api/client'
import { ApiError } from '../api/transport'
import { defaultSkin, skinContract, type SkinDocument } from '../skins/contract'
import oceanTokens from '../../../daemon/data/skins/example/tokens.json' with { type: 'json' }
import { useChatSessionStore } from '../stores/chatSessionStore'
import ChatPage from '../pages/ChatPage'
import { useOverlay } from '../hooks/useOverlay'
import { useI18n } from '../i18n'
import ResizablePanel from './ResizablePanel'
import ConfirmDialog from './ConfirmDialog'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import Icon from './Icon'
import SkinStudioPreview from './SkinStudioPreview'
import './SkinStudio.css'

const palettes = {
  light: { bg: '#ffffff', surface: '#f5f5f7', fg: '#1d1d1f', muted: '#86868b', border: '#e8e8ed', accent: '#0071e3', 'accent-fg': '#ffffff', 'accent-light': '#eaf3ff' },
  ocean: { bg: '#101923', surface: '#182838', fg: '#eaf2fa', muted: '#8a9fb4', border: '#2c4154', accent: '#56b8ff', 'accent-fg': '#102030', 'accent-light': '#183b58' },
  graphite: { bg: '#222329', surface: '#2c2d35', fg: '#ececf1', muted: '#9597a4', border: '#3e404c', accent: '#ae9bff', 'accent-fg': '#222329', 'accent-light': '#40394f' },
  mint: { bg: '#f8fcfa', surface: '#eef5f1', fg: '#263e35', muted: '#859b91', border: '#dce9e1', accent: '#31987b', 'accent-fg': '#ffffff', 'accent-light': '#e1f2e9' },
}
const baseLabels = { light: 'skins.studioBase_light', ocean: 'skins.studioBase_ocean', graphite: 'skins.studioBase_graphite', mint: 'skins.studioBase_mint' } as const
function SkinToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="skin-studio-toggle"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={checked} className="skin-studio-switch" onClick={() => onChange(!checked)}><span /></button></label>
}
function presetTokens(key: keyof typeof palettes) {
  const defaults = Object.fromEntries(Object.entries(skinContract.tokens).filter(([name]) => skinContract.token_kinds[name] === 'color'))
  const dark = key === 'ocean' || key === 'graphite'
  return { ...defaults, ...(dark ? oceanTokens : {}), ...palettes[key], 'accent-hover': palettes[key].accent,
    ...(key === 'graphite' ? { 'fg-2': '#c4c5cf', meta: '#9597a4', 'border-soft': '#353640' } : {}) }
}

export default function SkinStudio({ workspace, onClose, onSaved }: { workspace: SkinWorkspace; onClose: () => void; onSaved: (skin: SkinDocument) => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const mounted = useRef(true), priorRunning = useRef(false)
  const loadInFlight = useRef<{ path: string; request: Promise<void> } | null>(null)
  const readGeneration = useRef(0)
  const [skin, setSkin] = useState<SkinDocument | null>(null)
  const [revision, setRevision] = useState('')
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(workspace.session_id)
  const [pending, setPending] = useState<'close' | 'reload' | 'replace' | null>(null)
  const [base, setBase] = useState('custom'), [phone, setPhone] = useState(false)
  const [packagePath, setPackagePath] = useState(workspace.package_path)
  const [packageInput, setPackageInput] = useState(workspace.package_path)
  const session = useChatSessionStore(s => sessionId ? s.sessions[sessionId] : undefined)
  const running = Boolean(session?.running || session?.messages.some(message => message.role === 'assistant' && message.status === 'running'))
  const requestClose = () => { if (busy) return; if (dirty) setPending('close'); else onClose() }
  useOverlay(true, requestClose, ref)
  const project: Project = { id: workspace.project_id, name: workspace.project_name, path: workspace.workspace_path, steps: {}, workflows: [] }
  const load = useCallback(() => {
    if (loadInFlight.current?.path === packagePath) return loadInFlight.current.request
    const generation = ++readGeneration.current
    const request = skinsApi.validate(packagePath).then(result => {
      if (mounted.current && generation === readGeneration.current) { setSkin(result.skin); setRevision(result.skin.revision); setDirty(false); setBase('custom'); setError('') }
    }).catch(reason => {
      if (generation !== readGeneration.current || !mounted.current) return
      if (reason instanceof ApiError && reason.status === 404) {
        setSkin(current => current ?? { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'skin-' + workspace.session_id.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 50), name: t('skins.studioDefaultName'), version: '1.0.0' }, revision: '' })
        setRevision(''); setBase('light'); setError('')
      } else throw reason
    }).finally(() => { if (loadInFlight.current?.request === request) loadInFlight.current = null })
    loadInFlight.current = { path: packagePath, request }
    return request
  }, [packagePath, workspace.session_id, t])
  useEffect(() => {
    mounted.current = true
    void load().catch(reason => { if (mounted.current) setError(reason instanceof ApiError && reason.status === 404 ? '' : String(reason.message || reason)) })
    return () => { mounted.current = false }
  }, [load])
  useEffect(() => {
    if (priorRunning.current && !running) {
      if (dirty) setError(t('skins.studioChanged'))
      else void load().catch(reason => { if (mounted.current) setError(String(reason.message || reason)) })
    }
    priorRunning.current = running
  }, [running, dirty, load, t])
  const save = useCallback(async (create = false): Promise<boolean> => {
    if (busy || running) return false
    if (!skin) return !dirty
    if (!dirty && (!create || revision)) return true
    setBusy(true); setError('')
    try {
      const result = await skinsApi.saveDraft(packagePath, revision, skin)
      if (mounted.current) { setSkin(result.skin); setRevision(result.skin.revision); setDirty(false) }
      return true
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); return false }
    finally { if (mounted.current) setBusy(false) }
  }, [skin, dirty, busy, running, revision, packagePath])
  const register = async (replace = false) => {
    if (!await save(true)) return
    setBusy(true); setError('')
    try {
      const registered = await skinsApi.register(packagePath, replace)
      if (mounted.current) { setDirty(false); setPending(null); onSaved(registered) }
    } catch (reason) {
      if (!mounted.current) return
      if (reason instanceof ApiError && reason.status === 409) setPending('replace')
      else setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (mounted.current) setBusy(false) }
  }
  const edit = (change: (current: SkinDocument) => SkinDocument) => { setSkin(current => current ? change(current) : current); setDirty(true) }
  return createPortal(<div className="skin-studio-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
    <ResizablePanel ref={ref} minWidth={640} minHeight={460} className="skin-studio" role="dialog" aria-modal="true" aria-label={t('skins.studioTitle')} tabIndex={-1}>
      <header className="skin-studio-header" data-dialog-drag-handle><div><h2>{t('skins.studioTitle')}</h2><p>{t('skins.studioIntro')}</p></div><Button variant="icon" onClick={requestClose} aria-label={t('common.close')}><Icon name="x" size={18} /></Button></header>
      <div className="skin-studio-body">
        <section className="skin-studio-chat"><ChatPage embedded={{ project, sessionId, onSessionChange: setSessionId, beforeSend: save }} /></section>
        <aside className="skin-studio-controls"><h3>{t('skins.studioEditing')}</h3>
          {error && <p className="skin-studio-error" role="alert">{error}</p>}
          {!skin ? <><p className="skin-studio-note" role="status">{t('skins.studioWaiting')}</p><Button onClick={() => void load().catch(reason => setError(String(reason.message)))}>{t('common.retry')}</Button></> : <>
          <fieldset disabled={busy || running}>
            <label>{t('skins.studioName')}<Input value={skin.manifest.name} onChange={event => edit(current => ({ ...current, manifest: { ...current.manifest, name: event.target.value } }))} /></label>
            <label>{t('skins.studioBase')}<Select value={base} onChange={event => {
              const key = event.target.value as keyof typeof palettes
              setBase(key); if (!palettes[key]) return
              edit(current => ({ ...current, manifest: { ...current.manifest, color_scheme: ['ocean', 'graphite'].includes(key) ? 'dark' : 'light' }, tokens: { ...current.tokens, ...presetTokens(key) } }))
            }}><option value="custom">{t('skins.studioCustom')}</option>{(Object.keys(palettes) as (keyof typeof palettes)[]).map(key => <option key={key} value={key}>{t(baseLabels[key])}</option>)}</Select></label>
            <label>{t('skins.studioAccent')}<div className="skin-studio-palette">{['#0071e3', '#7c65d5', '#31987b', '#db9b42'].map(color => <button key={color} type="button" aria-label={color} aria-pressed={skin.tokens.accent === color} style={{ '--swatch-color': color } as React.CSSProperties} onClick={() => edit(current => ({ ...current, tokens: { ...current.tokens, accent: color } }))} />)}<input type="color" aria-label={t('skins.studioAccent')} value={/^#[\da-f]{6}$/i.test(skin.tokens.accent || '') ? skin.tokens.accent : '#0071e3'} onChange={event => edit(current => ({ ...current, tokens: { ...current.tokens, accent: event.target.value } }))} /></div></label>
            <label>{t('skins.studioEngine')}<Select value={skin.layout.engineAppearance || 'list'} onChange={event => edit(current => ({ ...current, layout: { ...current.layout, engineAppearance: event.target.value as 'list' | 'cards' } }))}><option value="list">{t('skins.studioList')}</option><option value="cards">{t('skins.studioCards')}</option></Select></label>
            <SkinToggle label={t('skins.studioRight')} checked={skin.layout.sidebarSide === 'right'} onChange={checked => edit(current => ({ ...current, layout: { ...current.layout, sidebarSide: checked ? 'right' : 'left' } }))} />
            <SkinToggle label={t('skins.studioTop')} checked={skin.layout.composerToolsPosition === 'top'} onChange={checked => edit(current => ({ ...current, layout: { ...current.layout, composerToolsPosition: checked ? 'top' : 'bottom' } }))} />
            <Button size="sm" disabled={!dirty || !skin.manifest.name.trim()} onClick={() => void save()} loading={busy}>{t('skins.studioSaveDraft')}</Button>
          </fieldset>
          <div className="skin-studio-preview-heading"><span>{t('skins.studioPreview')}</span><div><Button size="sm" variant={phone ? 'ghost' : 'primary'} onClick={() => setPhone(false)}>PC</Button><Button size="sm" variant={phone ? 'primary' : 'ghost'} onClick={() => setPhone(true)}>{t('skins.studioPhone')}</Button></div></div>
          <SkinStudioPreview skin={skin} compact={phone} />
          <p className="skin-studio-note">{t(running ? 'skins.studioRunning' : 'skins.studioNote')}</p>
          </>}
          <details className="skin-studio-package"><summary>{t('skins.studioPackage')}</summary><label><Input aria-label={t('skins.studioPackage')} value={packageInput} disabled={busy || running} onChange={event => setPackageInput(event.target.value)} /></label><Button size="sm" disabled={!packageInput.trim() || dirty || busy || running} onClick={() => {
            if (packageInput.trim() === packagePath) void load().catch(reason => setError(String(reason.message)))
            else { setSkin(null); setPackagePath(packageInput.trim()) }
          }}>{t('skins.studioReadPackage')}</Button></details>
          <Button size="sm" disabled={busy || running} onClick={() => dirty ? setPending('reload') : void load().catch(reason => setError(String(reason.message)))}>{t('skins.studioReload')}</Button>
        </aside>
      </div>
      <footer className="skin-studio-footer"><span>{t('skins.studioSaveHint')}</span><Button variant="primary" disabled={!skin || !skin.manifest.name.trim() || busy || running} loading={busy} onClick={() => void register()}>{t('skins.studioSave')}</Button></footer>
    </ResizablePanel>
    <ConfirmDialog open={pending === 'close' || pending === 'reload'} title={t('skins.studioDiscard')} onCancel={() => setPending(null)} onConfirm={() => { const action = pending; setPending(null); if (action === 'close') onClose(); else void load().catch(reason => setError(String(reason.message))) }} />
    <ConfirmDialog open={pending === 'replace'} title={t('skins.replace')} loading={busy} onCancel={() => { if (!busy) setPending(null) }} onConfirm={() => void register(true)} />
  </div>, document.body)
}
