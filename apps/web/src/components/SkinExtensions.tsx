import { Component, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useOverlay } from '../hooks/useOverlay'
import { useProjectStore } from '../stores/projectStore'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { appearanceScope } from '../utils/appearanceStorage'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { defaultSkin, type SkinDocument, type SkinMenu } from '../skins/contract'
import { saveSkin, useActiveSkin } from '../skins/runtime'
import { ExtensionSession, type ExtensionModule, type ExtensionSlotName, type SkinFeature } from '../skins/extensions'
import { executeSkinAction, skinActionEnabled, skinActionRevision, subscribeSkinActions, useSkinActions } from '../skins/actions'
import type { SettingsSection } from './SettingsNavigation'
import ResizablePanel from './ResizablePanel'
import ConfirmDialog from './ConfirmDialog'
import Button from './Button'
import Icon from './Icon'
import './SkinExtensions.css'

const RuntimeContext = createContext<ExtensionSession | null>(null)
const empty = { features: [], slots: [] }
const noSubscription = () => () => {}
const emptySnapshot = () => empty

class FeatureBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p role="alert">{this.props.label}</p> : this.props.children }
}

function FeatureContent({ session, feature, close, onDirtyChange }: { session: ExtensionSession; feature: SkinFeature; close: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const storage = useMemo(() => session.storage(feature.id), [session, feature.id])
  const Render = feature.render
  return <Render storage={storage} close={close} onDirtyChange={onDirtyChange} />
}

function FeatureDialog({ session, feature, onClose }: { session: ExtensionSession; feature: SkinFeature; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [dirty, setDirty] = useState(false), [confirm, setConfirm] = useState(false)
  const close = () => dirty ? setConfirm(true) : onClose()
  useOverlay(true, close, ref)
  return createPortal(<div className="skin-feature-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <ResizablePanel ref={ref} className="skin-feature-panel" data-ui="feature-panel" role="dialog" aria-modal="true" aria-label={feature.title} tabIndex={-1} minWidth={320} minHeight={320}>
      <header data-dialog-drag-handle><strong>{feature.title}</strong><Button variant="icon" aria-label={t('common.close')} onClick={close}><Icon name="x" /></Button></header>
      <div className="skin-feature-content"><FeatureBoundary label={t('skinExtensions.failed')}><FeatureContent session={session} feature={feature} close={close} onDirtyChange={setDirty} /></FeatureBoundary></div>
    </ResizablePanel>
    <ConfirmDialog open={confirm} title={t('skinExtensions.discard')} onCancel={() => setConfirm(false)} onConfirm={onClose} />
  </div>, document.body)
}

export function SkinExtensionSlot({ name }: { name: ExtensionSlotName }) {
  const { t } = useI18n()
  const session = useContext(RuntimeContext)
  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.snapshot ?? emptySnapshot, emptySnapshot)
  const widgets = snapshot.slots.filter(slot => slot.slot === name)
  if (!session || !widgets.length) return null
  return <div className="skin-extension-widgets" data-ui={name}>{widgets.map(feature => <FeatureBoundary key={feature.id} label={t('skinExtensions.failed')}>
    <FeatureContent session={session} feature={feature} close={() => {}} />
  </FeatureBoundary>)}</div>
}

function ExtensionMenu({ menu, session, onOpen, onError }: { menu: SkinMenu; session: ExtensionSession | null; onOpen: (id: string) => void; onError: (error: string) => void }) {
  useSyncExternalStore(subscribeSkinActions, skinActionRevision, skinActionRevision)
  return <nav className="skin-extension-menu" aria-label={menu.label} data-ui="extension-menu">
    <span className="skin-extension-menu-title">{menu.label}</span>
    {menu.items.map((item, index) => <Button key={index} size="sm" disabled={item.action === 'feature.open' ? !session?.snapshot().features.some(feature => feature.id === item.args?.id) : !(session?.enabled(item.action) ?? skinActionEnabled(item.action))}
      onClick={() => {
        if (item.action === 'feature.open') { onOpen(String(item.args?.id)); return }
        void (session ? session.execute(item.action, item.args) : executeSkinAction(item.action, item.args)).catch(error => onError(String(error instanceof Error ? error.message : error)))
      }}>{item.label}</Button>)}
  </nav>
}

/** Wraps the existing workspace without changing the identity of its business children. */
export default function SkinWorkspaceFrame({ children, onOpenSettings, loadModule }: {
  children: ReactNode; onOpenSettings: (section: SettingsSection) => void; loadModule?: (url: string) => Promise<ExtensionModule>
}) {
  const { t } = useI18n()
  const skin = useActiveSkin()
  const navigate = useNavigate()
  const project = useProjectStore(state => state.activeProject)
  const { bound, can } = useGatewayProjectPermissions(project?.id)
  const scope = appearanceScope() ?? `local:${gatewayWorkspacePath()}`
  const consentKey = `workstep:skin-code:${scope}:${skin.manifest.id}:${skin.revision}`
  const [consent, setConsent] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [session, setSession] = useState<ExtensionSession | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [openFeature, setOpenFeature] = useState<string | null>(null)
  const lastWorking = useRef<SkinDocument>(defaultSkin())
  let stored = false
  try { stored = localStorage.getItem(consentKey) === 'enabled' } catch { /* Consent can be used for the current visit. */ }
  const allowed = stored || consent === consentKey
  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscription, session?.snapshot ?? emptySnapshot, emptySnapshot)
  const currentSession = session?.skin.revision === skin.revision && session.skin.manifest.id === skin.manifest.id && session.scope === scope ? session : null

  useSkinActions({
    navigate: { run: args => {
      const path = String(args?.path ?? '')
      if (!/^\/(?:tasks|chat|canvas|statistics|schedules|git|appearance)(?:\?|$)/.test(path)) throw new Error('页面入口无效')
      navigate(path)
    } },
    'settings.open': { run: args => {
      const section = String(args?.section ?? 'providers')
      if (!['engines', 'providers', 'pricing', 'assistants', 'templates', 'roles', 'channels', 'remote', 'concurrency', 'git', 'appearance', 'system', 'feedback', 'sandbox'].includes(section)) throw new Error('设置入口无效')
      if (bound) { navigate('/appearance'); return }
      onOpenSettings(section as SettingsSection)
    }, enabled: () => !bound },
    'appearance.open': { run: () => bound ? navigate('/appearance') : onOpenSettings('appearance') },
    'chat.new': { enabled: () => !!project && can('session.create'), run: () => navigate(`/chat?project=${encodeURIComponent(project?.name ?? '')}`) },
  })

  useEffect(() => {
    setSession(null); setOpenFeature(null); setConfirm(false)
    if (!skin.script || !allowed || new URLSearchParams(window.location.search).get('skin') === 'default') {
      setLoading(false)
      if (!skin.script) lastWorking.current = skin
      return
    }
    const next = new ExtensionSession(skin, scope)
    let disposed = false
    setError(''); setLoading(true)
    void next.activate(loadModule).then(() => {
      if (disposed) return
      setSession(next); lastWorking.current = skin
    }).catch(reason => {
      if (disposed) return
      setError(String(reason instanceof Error ? reason.message : reason))
      saveSkin(lastWorking.current, 'error')
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true; try { next.dispose() } catch { /* A faulty cleanup must not block theme recovery. */ } }
  }, [skin, scope, allowed, loadModule])

  const selected = currentSession ? snapshot.features.find(feature => feature.id === openFeature) : undefined
  const menus = skin.menus ?? []
  const side = (position: 'top' | 'bottom' | 'left' | 'right') => <div className={`skin-workspace-${position}`} data-ui={`workspace-${position}`}>
    {menus.filter(menu => (menu.position ?? 'right') === position).map(menu => <ExtensionMenu key={menu.id} menu={menu} session={currentSession} onOpen={setOpenFeature} onError={setError} />)}
    {position === 'right' && currentSession && snapshot.features.some(feature => !menus.some(menu => menu.items.some(item => item.action === 'feature.open' && item.args?.id === feature.id))) && <nav className="skin-extension-menu" aria-label={t('skinExtensions.features')}>
      {snapshot.features.filter(feature => !menus.some(menu => menu.items.some(item => item.action === 'feature.open' && item.args?.id === feature.id))).map(feature => <Button key={feature.id} size="sm" onClick={() => setOpenFeature(feature.id)}>{feature.title}</Button>)}
    </nav>}
    <SkinExtensionSlot name={`workspace-${position}`} />
  </div>
  return <RuntimeContext.Provider value={currentSession}>
    <div className="skin-workspace-frame" data-ui="workspace">
      <div className="skin-workspace-top-area">{side('top')}
        {skin.script && !allowed && <div className="skin-extension-status" data-skin-recovery><span>{t('skinExtensions.codeDisabled')}</span><Button size="sm" onClick={() => setConfirm(true)}>{t('skinExtensions.enable')}</Button></div>}
        {loading && <div className="skin-extension-status" role="status"><Icon name="loader-circle" className="skin-extension-spinner" />{t('skinExtensions.loading')}</div>}
        {error && <div className="skin-extension-status" role="alert" data-skin-recovery><span>{t('skinExtensions.failed')} {error}</span><Button size="sm" onClick={() => setError('')}>{t('common.close')}</Button></div>}
      </div>
      {side('left')}{children}{side('right')}{side('bottom')}
    </div>
    <ConfirmDialog open={confirm} title={t('skinExtensions.enable')} message={t('skinExtensions.trust')} onCancel={() => setConfirm(false)} onConfirm={() => {
      try { localStorage.setItem(consentKey, 'enabled') } catch { /* Current visit only. */ }
      setConsent(consentKey); setConfirm(false)
    }} />
    {selected && currentSession && <FeatureDialog key={`${currentSession.skin.revision}:${selected.id}`} session={currentSession} feature={selected} onClose={() => setOpenFeature(null)} />}
  </RuntimeContext.Provider>
}
