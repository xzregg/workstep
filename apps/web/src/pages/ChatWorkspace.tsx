import { Fragment, startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Button from '../components/Button'
import Icon from '../components/Icon'
import ChatWindowMenu from '../components/ChatWindowMenu'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useChatPaneResize } from '../hooks/useChatPaneResize'
import { useI18n } from '../i18n'
import { useChatListStore } from '../stores/chatSessionStore'
import { useProjectStore } from '../stores/projectStore'
import ChatPage from './ChatPage'
import { randomUuid } from '../utils/uuid'
import { CHAT_SESSION_DRAG_TYPE, readChatSessionDrag } from '../utils/chatSessionDrag'
import { useRecentVisitsStore } from '../stores/recentVisitsStore'
import { useWsSubscriptionStore } from '../hooks/useWebSocket'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { resolveProjectPermissions } from '../utils/projectPermissions'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { appearanceStorageKey } from '../utils/appearanceStorage'
import { useChatWorkspaceStore, type ChatWorkspacePane as Pane } from '../stores/chatWorkspaceStore'
import './ChatWorkspace.css'

interface WorkspaceState { panes: Pane[]; activeId: string; routeKey: string }

/** Each pane reuses the complete session UI; only selection and arrangement live here. */
export default function ChatWorkspace() {
  const [params] = useSearchParams()
  const projects = useProjectStore(s => s.projects)
  const selectedProject = useProjectStore(s => s.activeProject)
  useGatewaySessionStore(s => s.session)
  const workspaceScope = appearanceStorageKey('chat-workspace')
  const projectName = params.get('project')
  const project = projectName ? projects.find(p => p.name === projectName) : selectedProject
  useEffect(() => {
    if (project) useProjectStore.getState().setActiveProject(project)
    const workflow = params.get('workflow')
    if (project && workflow && project.workflows?.some(item => item.id === workflow)) {
      useProjectStore.getState().setActiveWorkflow(workflow)
    }
  }, [project, params])
  if (!project) return <ChatPage />
  return <ProjectChatWorkspace key={workspaceScope} project={project} workspaceScope={workspaceScope} />
}

function ProjectChatWorkspace({ project, workspaceScope }: { project: NonNullable<ReturnType<typeof useProjectStore.getState>['activeProject']>; workspaceScope: string }) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const [params, setParams] = useSearchParams()
  const sessionId = params.get('session')
  const projects = useProjectStore(s => s.projects)
  const routeKey = JSON.stringify([project.id, sessionId])
  const [initial] = useState(() => {
    const saved = useChatWorkspaceStore.getState().workspaces[workspaceScope]
    if (!saved) return undefined
    const panes = saved.panes.filter(pane => projects.some(project => project.id === pane.projectId)
      && resolveProjectPermissions(isGatewayRemoteBrowser(), useGatewaySessionStore.getState().session, pane.projectId).can('session.read')).slice(0, 4)
    return panes.length ? { ...saved, panes } : undefined
  })
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>(() => initial?.layout || 'horizontal')
  const [dropping, setDropping] = useState(false)
  useEffect(() => {
    const clear = () => setDropping(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])
  const [state, setState] = useState<WorkspaceState>(() => {
    const panes = initial?.panes || [{ id: 'initial', projectId: project.id, sessionId }]
    return {
      panes, activeId: panes[0].id,
      routeKey: initial && sessionId ? JSON.stringify([panes[0].projectId, panes[0].sessionId]) : routeKey,
    }
  })
  const restoreRoute = useRef(Boolean(initial && !sessionId))
  // Reconcile external navigation before children render, so a sidebar click never
  // briefly hydrates the previous pane with another session's history.
  if (state.routeKey !== routeKey) {
    const existing = sessionId ? state.panes.find(p => p.projectId === project.id && p.sessionId === sessionId) : undefined
    const selected = state.panes.find(p => p.id === state.activeId)!
    setState({
      panes: state.panes.map(p => {
        if (p.id === state.activeId) return { ...p, projectId: project.id, sessionId }
        if (p.id === existing?.id) return { ...p, projectId: selected.projectId, sessionId: selected.sessionId }
        return p
      }),
      activeId: state.activeId,
      routeKey,
    })
  }
  const commit = useCallback((panes: Pane[], activeId: string, replace = false) => {
    const activePane = panes.find(p => p.id === activeId)!
    const nextProject = projects.find(p => p.id === activePane.projectId)
    if (!nextProject) return
    const nextSession = activePane.sessionId
    const next = new URLSearchParams(params)
    if (next.get('project') !== nextProject.name) next.delete('workflow')
    next.set('project', nextProject.name)
    if (nextSession) next.set('session', nextSession)
    else next.delete('session')
    startTransition(() => {
      setState({ panes, activeId, routeKey: JSON.stringify([activePane.projectId, nextSession]) })
      setParams(next, { replace })
    })
  }, [params, projects, setParams])
  const latest = useRef(state)
  latest.current = state
  const resize = useChatPaneResize(state.panes.map(p => p.id), layout, compact, initial?.sizes)
  useEffect(() => {
    useChatWorkspaceStore.getState().save(workspaceScope, { panes: state.panes, layout, sizes: resize.sizes })
  }, [workspaceScope, state.panes, layout, resize.sizes])
  useEffect(() => {
    if (!restoreRoute.current) return
    restoreRoute.current = false
    commit(latest.current.panes, latest.current.activeId, true)
  }, [commit])
  const remotePaneIds = JSON.stringify([...new Set(state.panes.map(p => p.projectId)
    .filter(id => projects.some(project => project.id === id && project.type === 'remote')))])
  useEffect(() => {
    useWsSubscriptionStore.setState({ chatProjectIds: JSON.parse(remotePaneIds) })
    return () => { useWsSubscriptionStore.setState({ chatProjectIds: [] }) }
  }, [remotePaneIds])
  const changeSession = (id: string, nextSession: string | null) => {
    const current = latest.current
    const source = current.panes.find(p => p.id === id)
    if (!source) return
    const existing = nextSession ? current.panes.find(p => p.projectId === source.projectId && p.sessionId === nextSession) : undefined
    commit(existing ? current.panes : current.panes.map(p => p.id === id ? { ...p, sessionId: nextSession } : p), existing?.id || id)
  }
  return <div className={`chat-workspace${dropping && !compact ? ' chat-workspace--dropping' : ''}`}
    onDragOverCapture={event => {
      if (compact || !event.dataTransfer.types.includes(CHAT_SESSION_DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setDropping(true)
    }}
    onDragLeave={event => {
      if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false)
    }}
    onDropCapture={event => {
      if (compact || !event.dataTransfer.types.includes(CHAT_SESSION_DRAG_TYPE)) return
      event.preventDefault()
      event.stopPropagation()
      setDropping(false)
      const dragged = readChatSessionDrag(event.dataTransfer)
      if (!dragged || !projects.some(p => p.id === dragged.projectId)) return
      const canRead = resolveProjectPermissions(isGatewayRemoteBrowser(), useGatewaySessionStore.getState().session, dragged.projectId).can('session.read')
      const listed = useChatListStore.getState().sessionsByProject[dragged.projectId]?.some(s => s.id === dragged.sessionId)
      const recent = useRecentVisitsStore.getState().entries.some(entry => entry.kind === 'session' && entry.projectId === dragged.projectId && entry.id === dragged.sessionId)
      if (!canRead || (!listed && !recent)) return
      const current = latest.current
      const existing = current.panes.find(p => p.projectId === dragged.projectId && p.sessionId === dragged.sessionId)
      if (existing) { commit(current.panes, existing.id); return }
      if (current.panes.length >= 4) return
      const pane = { id: randomUuid(), projectId: dragged.projectId, sessionId: dragged.sessionId }
      commit([...current.panes, pane], pane.id)
    }}>
    {dropping && !compact && <span className="chat-workspace-drop-hint" role="status">{t(state.panes.length >= 4 ? 'chatWorkspace.limitHint' : 'chatWorkspace.dropHint')}</span>}
    <div className="chat-workspace-panes-scroll">
    <div ref={resize.ref} style={resize.style} className={`chat-workspace-panes chat-workspace-panes--${layout} chat-workspace-panes--${state.panes.length}`}>
      {state.panes.map((pane, index) => {
        const paneProject = projects.find(p => p.id === pane.projectId)
        if (!paneProject) return null
        return <Fragment key={pane.id}><section
        className={`chat-workspace-pane${pane.id === state.activeId ? ' chat-workspace-pane--active' : ''}`}
        hidden={compact && pane.id !== state.activeId}
        aria-label={t('chatWorkspace.pane', { count: index + 1 })}
        onFocusCapture={() => { if (pane.id !== state.activeId) commit(state.panes, pane.id, true) }}
        onPointerDown={() => { if (pane.id !== state.activeId) commit(state.panes, pane.id, true) }}>
        <div className="chat-workspace-pane-content"><ChatPage pane={{
          project: paneProject, active: pane.id === state.activeId, sessionId: pane.sessionId,
          onSessionChange: id => changeSession(pane.id, id),
          headerActions: <ChatWindowMenu layout={layout} onChange={setLayout} canAdd={state.panes.length < 4} onAdd={() => {
            const current = latest.current
            if (current.panes.length >= 4) return
            const next = { id: randomUuid(), projectId: pane.projectId, sessionId: null }
            commit([...current.panes, next], next.id)
          }} />,
          closeAction: state.panes.length > 1 ? <Button className="chat-workspace-close" variant="ghost" size="sm" aria-label={t('chatWorkspace.close')} title={t('chatWorkspace.closeHint')} onClick={() => {
            const remaining = state.panes.filter(p => p.id !== pane.id)
            commit(remaining, pane.id === state.activeId ? remaining[Math.min(index, remaining.length - 1)].id : state.activeId, true)
          }}><Icon name="x" size={14} /></Button> : undefined,
        }} /></div>
      </section>
      {!compact && index < state.panes.length - 1 && <div className="chat-workspace-separator" role="separator" tabIndex={0}
        aria-orientation={layout === 'horizontal' ? 'vertical' : 'horizontal'} aria-label={t('chatWorkspace.resize')}
        onPointerDown={event => resize.startResize(event, index)} onKeyDown={event => resize.resizeWithKeys(event, index)} />}
      </Fragment>
      })}
    </div>
    </div>
  </div>
}
