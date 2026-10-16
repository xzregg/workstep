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
import { useChatListStore } from '../stores/chatSessionStore'
import { formatConversationDateTime, formatRelativeTime } from '../utils/datetime'
import RecentConversationActions from './RecentConversationActions'

export default function RecentConversations({ now = Date.now(), heading, collapsed = false }: { now?: number; heading?: ReactNode; collapsed?: boolean }) {
  const { t, locale } = useI18n()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const sessionsByProject = useChatListStore(s => s.sessionsByProject)
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
  const visible = entries.flatMap(entry => {
    const project = projects.find(p => p.id === entry.projectId)
    const permission = resolveProjectPermissions(isGatewayRemoteBrowser(), session, entry.projectId)
    return project && permission.can(entry.kind === 'task' ? 'task.read' : 'session.read') ? [{ entry, project, canManage: permission.can('session.manage') }] : []
  })
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
            useRecentVisitsStore.getState().visit(entry)
            setActiveProject(project)
            navigate(recentVisitPath(entry, project))
            dismiss?.()
          }}>
          <Icon name={entry.kind === 'task' ? 'workflow' : 'bot'} size={13} strokeWidth={2} />
          <span>{cached?.title || entry.title || entry.id}</span>
        </button>
        {entry.kind === 'session' && canManage ? <RecentConversationActions entry={entry}
          session={{ id: entry.id, title: cached?.title || entry.title, updated_at: timestamp }} now={now} hovered={hoveredId === rowKey} />
          : <time className="layout-recent-time" dateTime={timestamp} title={formatConversationDateTime(timestamp, now, locale)}>{formatRelativeTime(timestamp, now, t)}</time>}
        </div>
      })}
      {!visible.length && <div className="layout-sidebar-empty">{t('layout.noRecentConversations')}</div>}
    </div>
  </section>
}
