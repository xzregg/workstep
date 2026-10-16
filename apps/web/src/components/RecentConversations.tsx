import { useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useRecentVisitsStore, recentVisitPath } from '../stores/recentVisitsStore'
import { appearanceStorageKey } from '../utils/appearanceStorage'
import { resolveProjectPermissions } from '../utils/projectPermissions'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { NavigationDismissContext } from './NavigationDismissContext'
import Icon from './Icon'
import { useShallow } from 'zustand/react/shallow'
import SidebarStatusIndicator from './SidebarStatusIndicator'
import { recentActivityKey, useRecentActivityStore } from '../stores/recentActivityStore'
import { useChatSessionStore, useChatListStore } from '../stores/chatSessionStore'
import { formatConversationDateTime, formatRelativeTime } from '../utils/datetime'
import RecentConversationActions from './RecentConversationActions'
import RecentTaskActions from './RecentTaskActions'
import { deriveSessionFailedStateFromLastStatus, useSidebarActivityStore } from '../stores/sidebarActivityStore'

export default function RecentConversations({ now = Date.now(), heading, collapsed = false }: { now?: number; heading?: ReactNode; collapsed?: boolean }) {
  const { t, locale } = useI18n()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const sessionsByProject = useChatListStore(s => s.sessionsByProject)
  const runningTasks = useRecentActivityStore(s => s.runningTasks)
  const failedTasks = useRecentActivityStore(s => s.failedTasks)
  const completedTasks = useRecentActivityStore(s => s.completedTasks)
  const completedSessions = useSidebarActivityStore(s => s.completedSessions)
  const readFailedSessions = useSidebarActivityStore(s => s.readFailedSessions)
  const liveLastStatus = useChatSessionStore(useShallow(s => Object.fromEntries(
    Object.entries(s.sessions).map(([id, item]) => [id, item.messages?.at(-1)?.status ?? null]),
  )))
  const failedSessions = deriveSessionFailedStateFromLastStatus(Object.values(sessionsByProject).flat(), liveLastStatus)
  const liveRunning = useChatSessionStore(useShallow(s => Object.fromEntries(
    Object.entries(s.sessions).map(([id, item]) => [id, item.running]),
  )))
  const entries = useRecentVisitsStore(s => s.entries)
  const projects = useProjectStore(s => s.projects)
  const setActiveProject = useProjectStore(s => s.setActiveProject)
  const session = useGatewaySessionStore(s => s.session)
  const navigate = useNavigate()
  const location = useLocation()
  const dismiss = useContext(NavigationDismissContext)
  const scope = appearanceStorageKey('recent')
  useEffect(() => { useRecentVisitsStore.getState().hydrate() }, [scope, session])
  const params = new URLSearchParams(location.search)
  const activeTaskId = location.pathname === '/tasks' ? params.get('task') : null
  const activeProjectName = params.get('project')
  useEffect(() => {
    const project = projects.find(item => item.name === activeProjectName)
    if (!project || !activeTaskId) return
    const target = { projectId: project.id, id: activeTaskId }
    const key = recentActivityKey(target)
    if (failedTasks[key] || completedTasks[key]) useRecentActivityStore.getState().markTaskRead(target)
  }, [activeTaskId, activeProjectName, projects, failedTasks, completedTasks])
  const visible = entries.flatMap(entry => {
    const project = projects.find(p => p.id === entry.projectId)
    const permission = resolveProjectPermissions(isGatewayRemoteBrowser(), session, entry.projectId)
    return project && permission.can(entry.kind === 'task' ? 'task.read' : 'session.read') ? [{ entry, project, canManage: permission.can(entry.kind === 'task' ? 'task.archive' : 'session.manage') }] : []
  })
  const targetKey = JSON.stringify(visible.map(({ entry }) => ({ kind: entry.kind, projectId: entry.projectId, id: entry.id })))
  useEffect(() => {
    const targets = JSON.parse(targetKey) as Array<{ kind: 'task' | 'session'; projectId: string; id: string }>
    useRecentActivityStore.getState().setTargets(targets)
    for (const projectId of new Set(targets.filter(item => item.kind === 'session').map(item => item.projectId))) {
      if (!useChatListStore.getState().sessionsByProject[projectId]) {
        void useChatListStore.getState().fetchSessions(projectId, true)
      }
    }
  }, [targetKey, scope])
  useEffect(() => {
    const refresh = () => {
      void useRecentActivityStore.getState().refreshTasks()
      for (const projectId of new Set(useRecentActivityStore.getState().targets
        .filter(item => item.kind === 'session').map(item => item.projectId))) {
        const active = useProjectStore.getState().activeProject
        if (active?.id !== projectId || active.type === 'remote') {
          useChatListStore.getState().refreshSessions(projectId)
        }
      }
    }
    window.addEventListener('workstep:reconnected', refresh)
    return () => {
      window.removeEventListener('workstep:reconnected', refresh)
      useRecentActivityStore.getState().setTargets([])
    }
  }, [scope])
  return <section className="layout-sidebar-recent" aria-label={t('layout.recentConversations')}>
    {heading ?? <div className="layout-sidebar-section-label"><span>{t('layout.recentConversations')}</span></div>}
    <div id="workspace-recent-content" className="layout-sidebar-recent-list" hidden={collapsed}>
      {visible.map(({ entry, project, canManage }) => {
        const active = params.get('project') === project.name && (entry.kind === 'session'
          ? location.pathname === '/chat' && params.get('session') === entry.id
          : location.pathname === '/tasks' && params.get('task') === entry.id)
        const rowKey = `${entry.kind}:${entry.projectId}:${entry.id}`
        const cached = entry.kind === 'session' ? sessionsByProject[entry.projectId]?.find(item => item.id === entry.id) : undefined
        const timestamp = cached?.updated_at || cached?.created_at || new Date(entry.visitedAt).toISOString()
        return <div key={rowKey} className="layout-recent-item ws-row" data-active={active || undefined}
          onPointerEnter={event => { if (event.pointerType === 'mouse') setHoveredId(rowKey) }}
          onPointerLeave={event => { if (event.pointerType === 'mouse') setHoveredId(null) }}>
          <button className="layout-recent-row"
          aria-current={active ? 'page' : undefined} title={cached?.title || entry.title}
          onClick={() => {
            if (entry.kind === 'session') useSidebarActivityStore.getState().markSessionRead(entry.id)
            else useRecentActivityStore.getState().markTaskRead(entry)
            useRecentVisitsStore.getState().visit(entry)
            setActiveProject(project)
            navigate(recentVisitPath(entry, project))
            dismiss?.()
          }}>
          <Icon name={entry.kind === 'task' ? 'workflow' : 'bot'} size={13} strokeWidth={2} />
          <span className="layout-recent-title">{cached?.title || entry.title || entry.id}</span>
          <SidebarStatusIndicator
            running={entry.kind === 'task' ? runningTasks[recentActivityKey(entry)] : liveRunning[entry.id] ?? Boolean(cached?.running)}
            failed={entry.kind === 'task' ? failedTasks[recentActivityKey(entry)] : failedSessions[entry.id] && !readFailedSessions[entry.id]}
            completed={entry.kind === 'task' ? Boolean(completedTasks[recentActivityKey(entry)]) : Boolean(completedSessions[entry.id])}
            runningTitle={t('chatSession.runningHint')}
            failedTitle={t('layout.failedState')}
            completedTitle={t('layout.completedUnread')}
          />
        </button>
        {entry.kind === 'session' && canManage ? <RecentConversationActions entry={entry}
          session={{ id: entry.id, title: cached?.title || entry.title, updated_at: timestamp }} now={now} hovered={hoveredId === rowKey} />
          : entry.kind === 'task' && canManage ? <RecentTaskActions entry={entry} timestamp={timestamp} now={now} hovered={hoveredId === rowKey} />
          : <time className="layout-recent-time" dateTime={timestamp} title={formatConversationDateTime(timestamp, now, locale)}>{formatRelativeTime(timestamp, now, t)}</time>}
        </div>
      })}
      {!visible.length && <div className="layout-sidebar-empty">{t('layout.noRecentConversations')}</div>}
    </div>
  </section>
}
