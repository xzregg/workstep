import SkinWorkspaceFrame from './SkinExtensions'
import { useSkinSidebar } from '../hooks/useSkinSidebar'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { rememberWorkspacePage } from '@workstep/gateway-ui/workspaceResume'
import SidebarConversationTabs from './SidebarConversationTabs'
import ChatSessionSourceBadge from './ChatSessionSourceBadge'
import { useVisualViewport } from '../hooks/useVisualViewport'
import Icon from './Icon'
import ResponsiveNavigation from './ResponsiveNavigation'
import { BrandIcon } from './BrandIcon'
import { useState, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import SessionRowActions from './SessionRowActions'
import ChatSessionRenameDialog from './ChatSessionRenameDialog'
import { useTaskStore } from '../stores/taskStore'
import { useChatListStore } from '../stores/chatSessionStore'
import { writeChatSessionDrag } from '../utils/chatSessionDrag'
import { useSidebarActivityStore } from '../stores/sidebarActivityStore'
import { useRecentVisitsStore } from '../stores/recentVisitsStore'
import { useSidebarActivity } from '../hooks/useSidebarActivity'
import { useWebSocket } from '../hooks/useWebSocket'
import { taskListPath } from '../hooks/useTaskRoute'
import { useProjectRouteSelection } from '../hooks/useProjectRouteSelection'
import { useManagedMode } from '../hooks/useManagedMode'
import Button, { type ButtonProps } from './Button'
import MarqueeText from './MarqueeText'
import Input from './Input'
import SettingsPage from '../pages/SettingsPage'
import type { SettingsFocusTarget, SettingsSection } from '../pages/SettingsPage'
import ConfirmDialog from './ConfirmDialog'
import ProjectConnectionDialog from './ProjectConnectionDialog'
import ProjectShareDialog from './ProjectShareDialog'
import WorkflowCreateDialog from './WorkflowCreateDialog'
import SidebarStatusIndicator from './SidebarStatusIndicator'
import SandboxModeBadge from './SandboxModeBadge'
import GatewayConnectionStatus from './GatewayConnectionStatus'
import { loadSidebarSectionState, saveSidebarSectionState } from '../utils/sidebarSectionState'
import LayoutOnboardingActions from './LayoutOnboardingActions'
import WorkspaceNavigationActions, { WORKSPACE_TOOL_RAIL_WIDTH } from './WorkspaceNavigationActions'
import { useCompactLayout } from '../hooks/useCompactLayout'
import SidebarRenameField from './SidebarRenameField'
import { SidebarActionItem, SidebarActionMenu } from './SidebarActionMenu'
import { useOnboardingStore } from '../stores/onboardingStore'
import { filterSidebarProject } from '../utils/sidebarSearch'
import { useSidebarSessionActions } from '../hooks/useSidebarSessionActions'
import { useSidebarProjectLoading } from '../hooks/useSidebarProjectLoading'
import { useSidebarConversationLoading } from '../hooks/useSidebarConversationLoading'
import SidebarLoadStatus from './SidebarLoadStatus'
import WorkspaceSidebarSections from './WorkspaceSidebarSections'
import {
  engineApi,
  type Project,
} from '../api/client'
import './Layout.css'

function SidebarAddButton(props: ButtonProps) {
  return (
    <Button {...props} variant="icon" size="sm" className="sidebar-add-button">
      <Icon name="plus" size={9.6} strokeWidth={2} />
    </Button>
  )
}

const SIDEBAR_LONG_PRESS_MS = 500
const SIDEBAR_LONG_PRESS_MOVE_PX = 10

interface Props {
  onSelectProject: (p: Project) => void
  children: React.ReactNode
}

export default function Layout({ onSelectProject, children }: Props) {
  const { t } = useI18n()
  const managedMode = useManagedMode()
  const compact = useCompactLayout()
  useWebSocket()
  useVisualViewport()
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    try { rememberWorkspacePage(window.location.href, window.localStorage) } catch { /* Optional navigation memory. */ }
  }, [location.pathname, location.search])
  const [searchParams] = useSearchParams()
  // 侧栏会话列表的相对时间基准，每分钟刷新一次（Codex 风格）
  const [sidebarNow, setSidebarNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setSidebarNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  // 鼠标悬停显示行操作；触屏点按时间只显示归档按钮。
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const { projects, activeProject, activeWorkflowId, fetchProjects, setActiveProject, renameProject, deleteProject, renameWorkflow, deleteWorkflow, restoreWorkflow, reorderProjects, reorderWorkflows, setActiveWorkflow } = useProjectStore()
  const { bound, can } = useGatewayProjectPermissions(activeProject?.id)
  const [showInitModal, setShowInitModal] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('providers')
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocusTarget | undefined>()
  const [addWfProjectId, setAddWfProjectId] = useState<string | null>(null)
  const { width: sidebarWidth, begin: startSidebarDrag, nudge: nudgeSidebar } = useSkinSidebar()
  const [renameWfId, setRenameWfId] = useState<string | null>(null)
  const [deleteWf, setDeleteWf] = useState<{ id: string; projectId: string; name: string; soft: boolean } | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [deleteProjectError, setDeleteProjectError] = useState('')
  const [shareProject, setShareProject] = useState<Project | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ kind: 'project' | 'workflow'; id: string; x: number; y: number } | null>(null)
  const [dragProjectId, setDragProjectId] = useState<string | null>(null)
  const [dropProjectId, setDropProjectId] = useState<string | null>(null)
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('')
  const sidebarSearchInputRef = useRef<HTMLInputElement>(null)
  const sessionsByProject = useChatListStore((s) => s.sessionsByProject)
  const tasks = useTaskStore((s) => s.tasks)
  const selectedIds = useChatListStore((s) => s.selectedIds)
  const selectionProjectId = useChatListStore((s) => s.selectionProjectId)
  const bulkDeleting = useChatListStore((s) => s.bulkDeleting)
  const handleSelect = useChatListStore((s) => s.handleSelect)
  const clearSelection = useChatListStore((s) => s.clearSelection)
  const bulkRemove = useChatListStore((s) => s.bulkRemove)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [bulkDeleteError, setBulkDeleteError] = useState('')
  const activeSessionId = location.pathname === '/chat' ? searchParams.get('session') : null
  const mobileHeaderTitle = (activeProject && activeSessionId
    ? sessionsByProject[activeProject.id]?.find((session) => session.id === activeSessionId)?.title
    : null) || activeProject?.name || 'WorkStep'
  useProjectRouteSelection()
  const {
    completedSessions,
    completedWorkflows,
    failedChatSessions,
    failedWorkflows,
    markProjectRead,
    projectHasFailure,
    projectHasRunningSession,
    runningChatSessions,
  } = useSidebarActivity(activeSessionId)
  const [dragWfId, setDragWfId] = useState<string | null>(null)
  const [dropWfId, setDropWfId] = useState<string | null>(null)
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dropSessionId, setDropSessionId] = useState<string | null>(null)
  const [pendingWfSwitch, setPendingWfSwitch] = useState<{ project: Project; workflowId: string } | null>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const sidebarLongPressRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    timer: number
  } | null>(null)
  const suppressSidebarClickUntilRef = useRef(0)
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; sessionId: string; projectId: string; title: string } | null>(null)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameSessionProjectId, setRenameSessionProjectId] = useState<string | null>(null)
  const [renameSessionValue, setRenameSessionValue] = useState('')
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ sessionId: string; projectId: string; title: string } | null>(null)
  const {
    creatingSession,
    sessionError: sessionDeleteError,
    clearSessionError,
    createSession,
    deleteSession,
    archiveSession,
  } = useSidebarSessionActions()
  const [storedSidebarSections] = useState(loadSidebarSectionState)
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>(
    storedSidebarSections.expandedProjectIds,
  )
  const [sessionSectionOpen, setSessionSectionOpen] = useState<Record<string, boolean>>(
    storedSidebarSections.conversationsByProject,
  )
  const [flowSectionOpen, setFlowSectionOpen] = useState<Record<string, boolean>>(
    storedSidebarSections.flowsByProject,
  )
  const sidebarSearchResults = useMemo(() => new Map(projects.map((project) => [
    project.id,
    filterSidebarProject(project, sessionsByProject[project.id] || [], sidebarSearchQuery),
  ])), [projects, sessionsByProject, sidebarSearchQuery])
  const sidebarSearchActive = sidebarSearchQuery.trim().length > 0
  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [projectSectionVisible, setProjectSectionVisible] = useState(true)
  useSidebarConversationLoading(sidebarVisible && projectSectionVisible, can('session.read') && !sidebarSearchActive
    ? projects.filter((p) => expandedProjectIds.includes(p.id)
      && (sessionSectionOpen[p.id] ?? (location.pathname === '/chat' && !!activeSessionId))
      && !['revoked', 'expired', 'invalid'].includes(p.access_status ?? '')).map((p) => p.id)
    : [])
  const visibleProjects = sidebarSearchActive
    ? projects.filter((project) => sidebarSearchResults.get(project.id)?.visible)
    : projects
  const reloadSelectedProject = useSidebarProjectLoading(activeProject?.id ?? '')
  const projectLoading = useProjectStore(s => s.loading)
  const projectLoadError = useProjectStore(s => s.loadError)
  const remoteProjectErrors = useProjectStore(s => s.remoteLoadErrors)
  const sessionLoading = useChatListStore(s => s.listLoadingByProject)
  const sessionLoadErrors = useChatListStore(s => s.listErrorByProject)

  useEffect(() => {
    saveSidebarSectionState({
      expandedProjectIds,
      flowsByProject: flowSectionOpen,
      conversationsByProject: sessionSectionOpen,
    })
  }, [expandedProjectIds, flowSectionOpen, sessionSectionOpen])

  // Any mousedown outside the open menus dismisses them (row-level
  // stopPropagation handlers must not be able to swallow the close event).
  useEffect(() => {
    const closeAll = () => {
      setMoreMenu(null)
      setSessionMenu(null)
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (moreMenuRef.current?.contains(target)) return
      if (sessionMenuRef.current?.contains(target)) return
      closeAll()
    }
    const onBlur = () => closeAll()
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Running state is now tracked locally via projectStore.projectRunningState
  // (updated incrementally from WS events in taskStore.handleWsEvent).
  // No need to call fetchProjects on every status event.
  const projectRunningState = useProjectStore((s) => s.projectRunningState)

  // Auto-select project from URL ?project=name (only once)
  const projectName = searchParams.get('project')
  useEffect(() => {
    if (projectName || activeProject || projects.length === 0) return
    const rememberedProject = projects.find(
      (project) => storedSidebarSections.expandedProjectIds.includes(project.id),
    )
    if (rememberedProject) setActiveProject(rememberedProject)
  }, [projectName, projects, activeProject, setActiveProject, storedSidebarSections.expandedProjectIds])

  const isProjectExpanded = (projectId: string) => {
    if (!sidebarSearchActive) return expandedProjectIds.includes(projectId)
    const result = sidebarSearchResults.get(projectId)
    return Boolean(result && (result.workflows.length > 0 || result.sessions.length > 0))
  }

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjectIds((current) => (
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId]
    ))
  }

  useEffect(() => {
    if (!sidebarSearchOpen) return
    const timer = window.setTimeout(() => sidebarSearchInputRef.current?.focus(), 0)
    for (const project of projects) {
      if (project.type !== 'remote' && !(project.id in sessionsByProject)) {
        void useChatListStore.getState().fetchSessions(project.id)
      }
    }
    return () => window.clearTimeout(timer)
  }, [projects, sessionsByProject, sidebarSearchOpen])

  const handleSelectProject = (p: Project) => {
    if (activeProject?.id === p.id) reloadSelectedProject()
    setActiveProject(p)
    onSelectProject(p)
  }

  // Escape key clears multi-select
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useChatListStore.getState().selectedIds.size > 0) {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearSelection])

  const handleBulkDelete = async () => {
    if (!selectionProjectId) return
    try {
      await bulkRemove(selectionProjectId)
      setBulkDeleteError('')
    } catch {
      setBulkDeleteError(t('chatSession.deleteFailed'))
    }
    setBulkDeleteConfirm(false)
  }

  const cancelSidebarLongPress = () => {
    const pending = sidebarLongPressRef.current
    if (pending) window.clearTimeout(pending.timer)
    sidebarLongPressRef.current = null
  }

  const startSidebarLongPress = (
    event: ReactPointerEvent<HTMLElement>,
    openMenu: (x: number, y: number) => void,
  ) => {
    if (event.pointerType !== 'touch') return
    cancelSidebarLongPress()
    const pending = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
    }
    pending.timer = window.setTimeout(() => {
      if (sidebarLongPressRef.current !== pending) return
      sidebarLongPressRef.current = null
      suppressSidebarClickUntilRef.current = Date.now() + 800
      openMenu(pending.startX, pending.startY)
    }, SIDEBAR_LONG_PRESS_MS)
    sidebarLongPressRef.current = pending
  }

  const moveSidebarLongPress = (event: ReactPointerEvent<HTMLElement>) => {
    const pending = sidebarLongPressRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    if (
      Math.abs(event.clientX - pending.startX) > SIDEBAR_LONG_PRESS_MOVE_PX
      || Math.abs(event.clientY - pending.startY) > SIDEBAR_LONG_PRESS_MOVE_PX
    ) {
      cancelSidebarLongPress()
    }
  }

  const consumeSidebarLongPressClick = () => {
    if (Date.now() > suppressSidebarClickUntilRef.current) return false
    suppressSidebarClickUntilRef.current = 0
    return true
  }

  useEffect(() => cancelSidebarLongPress, [])

  const openMoreMenuAt = (kind: 'project' | 'workflow', id: string, x: number, y: number) => {
    if (kind === 'project' ? !can('project.settings') && !can('workflow.create') && !can('session.create') : !can('workflow.edit') && !can('workflow.delete')) return
    setSessionMenu(null)
    setMoreMenu({
      kind,
      id,
      x: Math.max(8, Math.min(x, window.innerWidth - 176)),
      y: Math.max(8, Math.min(y, window.innerHeight - (kind === 'project' ? 236 : 104))),
    })
  }

  const openMoreMenu = (e: React.MouseEvent, kind: 'project' | 'workflow', id: string) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const atCursor = e.type === 'contextmenu'
    openMoreMenuAt(kind, id, atCursor ? e.clientX : rect.left, atCursor ? e.clientY : rect.bottom + 4)
  }

  const menuTarget = moreMenu
    ? moreMenu.kind === 'project'
      ? projects.find((p) => p.id === moreMenu.id)
      : projects
          .flatMap((p) => (p.workflows || []).map((workflow) => ({ project: p, workflow })))
          .find(({ workflow }) => workflow.id === moreMenu.id)
    : undefined

  const openAddWorkflow = (projectId: string) => { if (can('workflow.create')) setAddWfProjectId(projectId) }

  const openLocalProjectModal = () => setShowInitModal(true)

  const handleProjectConnected = (project: Project) => {
    setActiveProject(project)
    const onboarding = useOnboardingStore.getState()
    if (
      project.type !== 'remote'
      && onboarding.status === 'active'
      && onboarding.completedSteps.includes('project')
    ) {
      onboarding.recordProject(project.id)
    }
    onSelectProject(project)
  }

  const openOnboardingSettings = (section: SettingsSection, focus: SettingsFocusTarget) => {
    setSettingsSection(section)
    setSettingsFocus(focus)
    setShowSettings(true)
  }

  const handleDeleteProject = async () => {
    if (!deleteProjectTarget) return
    const wasActive = activeProject?.id === deleteProjectTarget.id
    try {
      setDeleteProjectError('')
      const next = await deleteProject(deleteProjectTarget.id)
      setDeleteProjectTarget(null)
      if (wasActive) {
        if (next) onSelectProject(next)
        else navigate('/')
      }
    } catch (reason) {
      setDeleteProjectError(reason instanceof Error ? reason.message : t('layout.deleteProjectFailed'))
    }
  }

  const openSessionMenuAt = (projectId: string, sessionId: string, title: string, x: number, y: number) => {
    if (!can('session.manage')) return
    setMoreMenu(null)
    setSessionMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 176)),
      y: Math.max(8, Math.min(y, window.innerHeight - 148)),
      sessionId,
      projectId,
      title,
    })
  }

  const openSessionMenu = (e: React.MouseEvent, projectId: string, sessionId: string, title: string) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const atCursor = e.type === 'contextmenu'
    openSessionMenuAt(
      projectId,
      sessionId,
      title,
      atCursor ? e.clientX : rect.left,
      atCursor ? e.clientY : rect.bottom + 4,
    )
  }

  const handleDeleteSession = async () => {
    if (!deleteSessionTarget) return
    const { sessionId, projectId } = deleteSessionTarget
    if (await deleteSession(sessionId, projectId)) setDeleteSessionTarget(null)
  }

  const handleArchiveSession = (sessionId: string, projectId: string) => {
    setSessionMenu(null)
    void archiveSession(sessionId, projectId)
  }

  return (
    <SkinWorkspaceFrame onOpenSettings={section => { setSettingsSection(section); setSettingsFocus(undefined); setShowSettings(true) }}>
    <div className="app-shell" data-ui="app-shell">
      {/* Sidebar */}
      <ResponsiveNavigation className="layout-sidebar" onVisibilityChange={setSidebarVisible} showNew={can('session.create')} newDisabled={!activeProject} dismissSignal={`${showSettings}:${showInitModal}:${addWfProjectId}`} title={mobileHeaderTitle} showBrandIcon={!activeSessionId} onNew={() => navigate(`/chat?project=${encodeURIComponent(activeProject?.name || "")}`)} style={{ width: sidebarWidth + (compact ? 0 : WORKSPACE_TOOL_RAIL_WIDTH) }}>
        <div className="layout-sidebar-header">
          <div className="layout-sidebar-brand">
            <BrandIcon size={18} />
            <span className="layout-sidebar-brand-name">WorkStep</span>
            <SandboxModeBadge />
            <GatewayConnectionStatus onOpenSettings={() => { setSettingsSection('remote'); setShowSettings(true) }} />
            <a
              href="/landing"
              className="layout-sidebar-intro"
            >
              {t('layout.intro')}
            </a>
          </div>
        </div>

        <WorkspaceSidebarSections now={sidebarNow} onProjectVisibilityChange={setProjectSectionVisible}
          projectActions={<>
          <Button
            variant="icon"
            aria-label={t('layout.searchSidebar')}
            title={t('layout.searchSidebar')}
            aria-expanded={sidebarSearchOpen}
            onClick={() => {
              setSidebarSearchOpen((open) => {
                if (open) setSidebarSearchQuery('')
                return !open
              })
            }}
            className="layout-sidebar-search-button"
          >
            <Icon name="search" size={14} strokeWidth={2} />
          </Button>

        {sidebarSearchOpen && (
          <div className="layout-sidebar-search">
            <Icon
              name="search"
              size={14}
              strokeWidth={2}
              className="layout-sidebar-search-icon"
            />
            <Input
              ref={sidebarSearchInputRef}
              type="search"
              aria-label={t('layout.searchSidebar')}
              placeholder={t('layout.searchSidebarPlaceholder')}
              value={sidebarSearchQuery}
              onChange={(event) => setSidebarSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setSidebarSearchQuery('')
                  setSidebarSearchOpen(false)
                }
              }}
              className="layout-sidebar-search-input"
            />
          </div>
        )}

          {!bound && <Button variant="icon" size="sm" className="layout-sidebar-search-button"
            aria-label={t('nav.addProject')} title={t('nav.addProject')} onClick={openLocalProjectModal}>
            <Icon name="plus" size={14} strokeWidth={2} />
          </Button>}
          </>}
          projects={
        <div className="layout-sidebar-projects">
          {visibleProjects.map((p) => {
            const searchResult = sidebarSearchResults.get(p.id)!
            return (
            <div key={p.id}>
              <div
                onClick={() => {
                  if (consumeSidebarLongPressClick()) return
                  markProjectRead(p.id)
                  handleSelectProject(p)
                  toggleProjectExpanded(p.id)
                }}
                onPointerDown={(e) => startSidebarLongPress(e, (x, y) => openMoreMenuAt('project', p.id, x, y))}
                onPointerMove={moveSidebarLongPress}
                onPointerUp={cancelSidebarLongPress}
                onPointerCancel={cancelSidebarLongPress}
                onPointerLeave={cancelSidebarLongPress}
                draggable={can('project.settings') && renameId !== p.path}
                onDragStart={(e) => {
                  e.stopPropagation()
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', p.id)
                  setDragProjectId(p.id)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dropProjectId !== p.id) setDropProjectId(p.id)
                }}
                onDragLeave={(e) => {
                  e.stopPropagation()
                  if (dropProjectId === p.id) setDropProjectId(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const dragId = dragProjectId || e.dataTransfer.getData('text/plain')
                  const targetId = p.id
                  setDragProjectId(null)
                  setDropProjectId(null)
                  if (!dragId || dragId === targetId) return
                  const ids = projects.map((item) => item.id)
                  if (!ids.includes(dragId) || !ids.includes(targetId)) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const before = e.clientY < rect.top + rect.height / 2
                  const next = ids.filter((id) => id !== dragId)
                  const targetIndex = next.indexOf(targetId)
                  next.splice(before ? targetIndex : targetIndex + 1, 0, dragId)
                  if (next.join(',') !== ids.join(',')) {
                    void reorderProjects(next)
                  }
                }}
                onDragEnd={() => { setDragProjectId(null); setDropProjectId(null) }}
                onContextMenu={(e) => openMoreMenu(e, 'project', p.id)}
                className="layout-project-row ws-row"
                data-active={activeProject?.id === p.id}
                data-dragging={dragProjectId === p.id}
                data-drop-target={dropProjectId === p.id}
              >

                <Button
                  variant="icon"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleProjectExpanded(p.id)
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-expanded={isProjectExpanded(p.id)}
                  aria-controls={`sidebar-project-${p.id}`}
                  aria-label={t(isProjectExpanded(p.id) ? 'layout.collapseProject' : 'layout.expandProject', { name: p.name })}
                  title={t(isProjectExpanded(p.id) ? 'layout.collapseProject' : 'layout.expandProject', { name: p.name })}
                  className="layout-project-expand-button"
                >
                  <Icon
                    name={p.type === 'remote' ? 'external-link' : isProjectExpanded(p.id) ? 'folder-open' : 'folder'} size={16.4} strokeWidth={2}
                  />
                </Button>
                {renameId === p.path ? (
                  <SidebarRenameField
                    kind="project"
                    initialName={p.name}
                    onSave={async (name) => {
                      await renameProject(p.path, name)
                      if (searchParams.get('project') === p.name) {
                        const next = new URLSearchParams(searchParams)
                        next.set('project', name)
                        navigate(`${location.pathname}?${next}`, { replace: true })
                      }
                    }}
                    onClose={() => setRenameId(null)}
                  />
                ) : (
                  <span className="layout-project-name">
                    {p.name}
                    {p.type === 'remote' && (
                      <span
                        title={p.access_status === 'invalid' ? t('layout.remoteAccessInvalidHint') : p.access_status === 'revoked'
                          ? t('layout.remoteAccessRevoked')
                          : p.access_status === 'expired'
                            ? t('layout.remoteAccessExpired')
                            : p.endpoint}
                        className="layout-project-remote-badge"
                        data-access-status={p.access_status}
                      >
                        {p.access_status === 'invalid' ? t('layout.remoteAccessInvalid') : p.access_status === 'revoked'
                          ? t('layout.remoteAccessRevoked')
                          : p.access_status === 'expired'
                            ? t('layout.remoteAccessExpired')
                            : t('layout.remoteLabel')}
                      </span>
                    )}
                  </span>
                )}
                {!isProjectExpanded(p.id) && (() => {
                  // Real-time signals (always fresh):
                  //  - local task running state (from WS events)
                  //  - live chat session running state
                  const sessionRunning = projectHasRunningSession(p.id)
                  const localTaskState = projectRunningState[p.id] // undefined | true | false
                  const realtimeRunning = localTaskState === true || sessionRunning
                  // If we have a local task record (even false), real-time
                  // signals are authoritative — skip stale backend snapshots.
                  if (localTaskState !== undefined) return realtimeRunning
                  // No local record yet (initial state): fall back to backend
                  // aggregate + local tasks array.
                  return realtimeRunning
                    || p.workflows?.some((workflow) => workflow.running)
                    || p.has_running_tasks
                    || (p.id === activeProject?.id && tasks.some((task) => task.status === 'running'))
                })() ? (
                  <SidebarStatusIndicator
                    running
                    runningTitle={projectHasRunningSession(p.id) ? t('chatSession.runningHint') : t('layout.flowRunning')}
                    failedTitle={t('layout.failedState')}
                    completedTitle={t('layout.completedUnread')}
                  />
                ) : !isProjectExpanded(p.id) ? (
                  <SidebarStatusIndicator
                    failed={projectHasFailure(p.id)}
                    completed={Object.values(completedWorkflows).includes(p.id)}
                    runningTitle={t('layout.flowRunning')}
                    failedTitle={t('layout.failedState')}
                    completedTitle={t('layout.completedUnread')}
                  />
                ) : null}
                {(can('project.settings') || can('workflow.create') || can('session.create')) && <Button
                  variant="icon"
                  className="ws-more-btn"
                  disabled={false}
                  onClick={(e) => openMoreMenu(e, 'project', p.id)}
                  title={t('layout.moreActions')}
                  aria-label={t('layout.moreActions')}
                >⋯</Button>}
              </div>

              {/* Workflow list + sessions under the selected project */}
              {isProjectExpanded(p.id) && (
                <div id={`sidebar-project-${p.id}`}>
                  {p.type === 'remote' && !p.workflows?.length && <SidebarLoadStatus
                    loading={sessionLoading[p.id] && !(p.id in sessionsByProject)} error={sessionLoadErrors[p.id] || remoteProjectErrors[p.id]}
                    label={t(p.access_status === 'invalid' ? 'layout.remoteAccessInvalidHint' : 'layout.projectLoadFailed')}
                    onRetry={p.access_status === 'invalid' ? undefined : () => {
                      if (remoteProjectErrors[p.id]) void useProjectStore.getState().fetchRemoteProject(p.id)
                      else useChatListStore.getState().refreshSessions(p.id)
                    }} />}
                  {(() => {
                    const flowOpen = sidebarSearchActive
                      ? searchResult.workflows.length > 0
                      : flowSectionOpen[p.id] !== false
                    return (
                      <>
                        <div
                          className="layout-sidebar-nested-label"
                          data-open={flowOpen}
                          onClick={(e) => {
                            e.stopPropagation()
                            setFlowSectionOpen((prev) => ({ ...prev, [p.id]: !flowOpen }))
                          }}
                        >
                          <span className="layout-sidebar-section-name">
                            <Icon
                              name={flowOpen ? 'folder-open' : 'folder'} size={14} strokeWidth={2}
                              className="layout-sidebar-section-icon"
                            />
                            {t('chatSession.flowSection')}
                          </span>
                          {can('workflow.create') && flowOpen && (
                            <SidebarAddButton
                              onClick={(e) => { e.stopPropagation(); void openAddWorkflow(p.id) }}
                              title={t('layout.addWorkflowTitle')}
                              aria-label={t('layout.addWorkflowTitle')}
                            />
                          )}
                        </div>
                        {flowOpen && searchResult.workflows.map(wf => (
                (() => {
                  const deleted = !!wf.deleted
                  const isDragSource = dragWfId === wf.id
                  const isDropTarget = dropWfId === wf.id
                  const workflowSelected = location.pathname !== '/chat'
                    && activeProject?.id === p.id
                    && activeWorkflowId === wf.id
                  return (
                    <div key={wf.id}>
                    <div
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (deleted) return
                        useSidebarActivityStore.getState().markWorkflowRead(wf.id)
                        const dirty = useProjectStore.getState().canvasDirty
                        if (location.pathname === '/canvas' && dirty) {
                          setPendingWfSwitch({ project: p, workflowId: wf.id })
                          return
                        }
                        setActiveProject(p)
                        await setActiveWorkflow(wf.id)
                        navigate(taskListPath(p.name, wf.id))
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openMoreMenu(e, 'workflow', wf.id)
                      }}
                      className="layout-workflow-row ws-row"
                      data-deleted={deleted}
                      data-active={workflowSelected}
                      data-dragging={isDragSource}
                      data-drop-target={isDropTarget}
                      draggable={can('workflow.edit') && renameWfId !== wf.id}
                      onDragStart={(e) => {
                        e.stopPropagation()
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', wf.id)
                        setDragWfId(wf.id)
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (dropWfId !== wf.id) setDropWfId(wf.id)
                      }}
                      onDragLeave={(e) => {
                        e.stopPropagation()
                        if (dropWfId === wf.id) setDropWfId(null)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        const dragId = dragWfId || e.dataTransfer.getData('text/plain')
                        const targetId = wf.id
                        setDragWfId(null)
                        setDropWfId(null)
                        if (!dragId || dragId === targetId) return
                        const ids = (p.workflows || []).map((w) => w.id)
                        if (!ids.includes(dragId) || !ids.includes(targetId)) return
                        const rect = e.currentTarget.getBoundingClientRect()
                        const before = e.clientY < rect.top + rect.height / 2
                        const next = ids.filter((id) => id !== dragId)
                        const targetIndex = next.indexOf(targetId)
                        next.splice(before ? targetIndex : targetIndex + 1, 0, dragId)
                        if (next.join(',') !== ids.join(',')) {
                          void reorderWorkflows(p.id, next)
                        }
                      }}
                      onDragEnd={() => { setDragWfId(null); setDropWfId(null) }}
                      title={t('layout.dragToReorder')}
                    >
                      <Icon name="workflow" size={12.8} strokeWidth={2} />
                      {renameWfId === wf.id ? (
                        <SidebarRenameField
                          kind="workflow"
                          initialName={wf.name}
                          onSave={(name) => renameWorkflow(wf.id, p.id, name)}
                          onClose={() => setRenameWfId(null)}
                        />
                      ) : (
                        <MarqueeText
                          text={wf.name}
                          onDoubleClick={(e) => { e.stopPropagation(); if (!deleted && can('workflow.edit')) setRenameWfId(wf.id) }}
                          className="layout-workflow-name"
                        />
                      )}
                      {!deleted && (
                        <SidebarStatusIndicator
                          running={Boolean(wf.running || (
                            p.id === activeProject?.id
                            && tasks.some((task) => task.workflow_id === wf.id && task.status === 'running')
                          ))}
                          failed={failedWorkflows[wf.id]}
                          completed={Boolean(completedWorkflows[wf.id])}
                          runningTitle={t('layout.flowRunning')}
                          failedTitle={t('layout.failedState')}
                          completedTitle={t('layout.completedUnread')}
                        />
                      )}
                      {deleted && <span className="layout-workflow-trash">{t('layout.trash')}</span>}
                      {wf.is_default ? <span className="layout-workflow-default">{t('layout.default')}</span> : null}
                      <span className="layout-workflow-node-count">{t('flow.nodeCount', { count: wf.nodeCount })}</span>
                      {(can('workflow.edit') || can('workflow.delete')) && <Button
                        variant="icon"
                        className="ws-more-btn"
                        disabled={false}
                        onClick={(e) => openMoreMenu(e, 'workflow', wf.id)}
                        title={t('layout.moreActions')}
                        aria-label={t('layout.moreActions')}
                      >⋯</Button>}
                    </div>
                    </div>
                  )
                })()
              ))}
                      </>
                    )
                  })()}
              {(() => {
                const open = sidebarSearchActive
                  ? searchResult.sessions.length > 0
                  : sessionSectionOpen[p.id]
                    ?? (location.pathname === '/chat' && !!activeSessionId)
                return can('session.read') && (
                  <SidebarConversationTabs sessions={searchResult.sessions} activeSessionId={activeSessionId} onSwitch={clearSelection} open={open} header={(tabs, tab) => (
                    <div
                      className="layout-sidebar-nested-label layout-sidebar-session-label"
                      data-open={open}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSessionSectionOpen((prev) => ({ ...prev, [p.id]: !open }))
                      }}
                    >
                      <span className="layout-sidebar-section-name">
                        <Icon
                          name={open ? 'folder-open' : 'folder'} size={14} strokeWidth={2}
                          className="layout-sidebar-section-icon"
                        />
                        {t('chatSession.navSection')}
                      </span>
                      {tabs}
                      {can('session.create') && open && tab === 'chat' && (
                        <SidebarAddButton
                          loading={creatingSession}
                          disabled={creatingSession}
                          onClick={(e) => { e.stopPropagation(); void createSession(p) }}
                          title={t('chatSession.newSession')}
                          aria-label={t('chatSession.newSession')}
                            />
                      )}
                    </div>
                    )}>
                      {visibleSessions => <div className="layout-session-list">
                      <SidebarLoadStatus loading={sessionLoading[p.id] && !(p.id in sessionsByProject)} error={sessionLoadErrors[p.id]}
                        label={t(p.access_status === 'invalid' ? 'layout.remoteAccessInvalidHint' : 'layout.sessionLoadFailed')}
                        onRetry={p.access_status === 'invalid' ? undefined : () => useChatListStore.getState().refreshSessions(p.id)} />
                      {/* Bulk action bar (visible when 2+ sessions selected) */}
                      {selectionProjectId === p.id && selectedIds.size >= 2 && (
                        <div className="layout-session-bulk-actions">
                          <span className="layout-session-bulk-count">{t('chatSession.selectedCount', { count: selectedIds.size })}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={bulkDeleting}
                            disabled={bulkDeleting || !can('session.manage')}
                            onClick={(e) => { e.stopPropagation(); setBulkDeleteError(''); setBulkDeleteConfirm(true) }}
                            title={t('chatSession.bulkDelete')}
                            className="layout-session-bulk-button layout-session-bulk-delete"
                          >
                            <Icon name="trash" size={10} strokeWidth={2} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); clearSelection() }}
                            title={t('chatSession.deselectAll')}
                            className="layout-session-bulk-button"
                          >
                            <Icon name="x" size={10} strokeWidth={2} />
                          </Button>
                        </div>
                      )}
                      {visibleSessions.map(session => {
                        const isDragSource = dragSessionId === session.id
                        const isDropTarget = dropSessionId === session.id
                        const sessionRunning = Boolean(runningChatSessions[session.id])
                        const isSelected = selectionProjectId === p.id && selectedIds.has(session.id)
                        const isMultiSelect = selectionProjectId === p.id && selectedIds.size > 1
                        return (
                        <div
                          key={session.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (consumeSidebarLongPressClick()) return
                            if (renameSessionId === session.id) return
                            handleSelect(session.id, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey }, p.id)
                            // Only navigate on plain click (no modifiers)
                            if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
                              useSidebarActivityStore.getState().markSessionRead(session.id)
                              useRecentVisitsStore.getState().visit({ kind: 'session', id: session.id, projectId: p.id, title: session.title })
                              navigate(`/chat?project=${encodeURIComponent(p.name)}&session=${encodeURIComponent(session.id)}`)
                            }
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            if (!can('session.manage')) return
                            clearSelection()
                            setRenameSessionId(session.id)
                            setRenameSessionProjectId(p.id)
                            setRenameSessionValue(session.title)
                          }}
                          onPointerDown={(e) => startSidebarLongPress(e, (x, y) => openSessionMenuAt(p.id, session.id, session.title, x, y))}
                          onPointerMove={moveSidebarLongPress}
                          onPointerUp={cancelSidebarLongPress}
                          onPointerCancel={cancelSidebarLongPress}
                          onPointerLeave={(e) => {
                            cancelSidebarLongPress()
                            if (e.pointerType === 'mouse') setHoveredSessionId(null)
                          }}
                          onContextMenu={(e) => openSessionMenu(e, p.id, session.id, session.title)}
                          onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHoveredSessionId(session.id) }}
                          className="layout-session-row ws-row"
                          data-selected={isSelected}
                          data-active={location.pathname === '/chat' && activeSessionId === session.id}
                          data-dragging={isDragSource}
                          data-drop-target={isDropTarget}
                          draggable={!compact && can('session.read') && renameSessionId !== session.id && !isMultiSelect}
                          onDragStart={(e) => {
                            e.stopPropagation()
                            writeChatSessionDrag(e.dataTransfer, p.id, session.id)
                            setDragSessionId(session.id)
                          }}
                          onDragOver={(e) => {
                            if (isMultiSelect || !can('session.manage')) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dropSessionId !== session.id) setDropSessionId(session.id)
                          }}
                          onDragLeave={(e) => {
                            e.stopPropagation()
                            if (dropSessionId === session.id) setDropSessionId(null)
                          }}
                          onDrop={(e) => {
                            if (isMultiSelect || !can('session.manage')) return
                            e.preventDefault()
                            e.stopPropagation()
                            const dragId = dragSessionId || e.dataTransfer.getData('text/plain')
                            const targetId = session.id
                            setDragSessionId(null)
                            setDropSessionId(null)
                            if (!dragId || dragId === targetId) return
                            const ids = (sessionsByProject[p.id] || []).map((item) => item.id)
                            if (!ids.includes(dragId) || !ids.includes(targetId)) return
                            const rect = e.currentTarget.getBoundingClientRect()
                            const before = e.clientY < rect.top + rect.height / 2
                            const next = ids.filter((id) => id !== dragId)
                            const targetIndex = next.indexOf(targetId)
                            next.splice(before ? targetIndex : targetIndex + 1, 0, dragId)
                            if (next.join(',') !== ids.join(',')) {
                              void useChatListStore.getState().reorderSessions(p.id, next)
                            }
                          }}
                          onDragEnd={() => { setDragSessionId(null); setDropSessionId(null) }}
                          title={isMultiSelect ? t('chatSession.multiSelectHint') : t('layout.dragToReorder')}
                        >
                          {/* Checkbox indicator (always shown in multi-select mode) */}
                          {isMultiSelect && (
                            <span className="layout-session-checkbox" data-selected={isSelected}>
                              {isSelected && <Icon name="check" size={9} strokeWidth={3} className="layout-session-check" />}
                            </span>
                          )}
                          <Icon name="bot" size={11.6} strokeWidth={2} className="layout-session-bot" />
                          <MarqueeText text={session.title} />
                          <ChatSessionSourceBadge source={session.source} platform={session.channel_platform} botName={session.channel_name} conversationType={session.channel_conversation_type} peerName={session.channel_peer_name} />
                          <SidebarStatusIndicator
                            running={sessionRunning}
                            failed={failedChatSessions[session.id]}
                            completed={Boolean(completedSessions[session.id])}
                            runningTitle={t('chatSession.runningHint')}
                            failedTitle={t('layout.failedState')}
                            completedTitle={t('layout.completedUnread')}
                          />
                          {can('session.manage') && <SessionRowActions showMore={!compact}
                            session={session}
                            hovered={hoveredSessionId === session.id}
                            now={sidebarNow}
                            onArchive={() => { void handleArchiveSession(session.id, p.id) }}
                            onMore={(e) => openSessionMenu(e, p.id, session.id, session.title)}
                          />}
                        </div>
                        )
                      })}
                      </div>}
                  </SidebarConversationTabs>
                )
              })()}
                </div>
              )}
            </div>
            )
          })}
          <SidebarLoadStatus loading={projectLoading && projects.length === 0} error={projectLoadError}
            label={t('layout.projectLoadFailed')} onRetry={() => void fetchProjects()} />
          {projects.length === 0 && !projectLoading && !projectLoadError && (
            <div className="layout-sidebar-empty">
              {t('nav.noProjects')}
            </div>
          )}
          {projects.length > 0 && visibleProjects.length === 0 && (
            <div className="layout-sidebar-empty">
              {t('layout.noSidebarMatches')}
            </div>
          )}
        </div>

          }
        />
        <WorkspaceNavigationActions activeSettingsSection={showSettings ? settingsSection : undefined}
          onOpenSettings={section => { setSettingsSection(section); setSettingsFocus(undefined); setShowSettings(true) }} />
      </ResponsiveNavigation>

      <div
        className="task-detail-split-handle"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={startSidebarDrag}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          nudgeSidebar(e.key === 'ArrowLeft' ? -16 : 16)
        }}
      />

      {moreMenu && (
        <SidebarActionMenu ref={moreMenuRef} x={moreMenu.x} y={moreMenu.y}>
          {moreMenu.kind === 'project' && menuTarget && 'path' in menuTarget && (
            <>
              {(managedMode !== true || menuTarget.is_default_workspace) && menuTarget.type !== 'remote' && !bound && can('project.settings') && (
                <SidebarActionItem
                  icon="pencil"
                  onClick={() => { setRenameId(menuTarget.path); setMoreMenu(null) }}
                >
                  {t('common.rename')}
                </SidebarActionItem>
              )}
              {can('workflow.create') && <SidebarActionItem
                icon="plus"
                onClick={() => { openAddWorkflow(menuTarget.id); setMoreMenu(null) }}
              >
                {t('layout.addWorkflowTitle')}
              </SidebarActionItem>}
              {can('session.create') && <SidebarActionItem
                icon="bot"
                onClick={() => {
                  setMoreMenu(null)
                  void createSession(menuTarget)
                }}
              >
                {t('chatSession.addSessionTitle')}
              </SidebarActionItem>}
              {menuTarget.type !== 'remote' && !isGatewayRemoteBrowser() && (
                <SidebarActionItem
                  icon="share"
                  onClick={() => { setShareProject(menuTarget); setMoreMenu(null) }}
                >
                  {t('layout.remoteShareTitle')}
                </SidebarActionItem>
              )}
              {!bound && !menuTarget.is_default_workspace && can('project.settings') && <SidebarActionItem
                icon="trash"
                danger
                onClick={() => { setDeleteProjectError(''); setDeleteProjectTarget(menuTarget); setMoreMenu(null) }}
              >
                {t('layout.deleteProjectTitle')}
              </SidebarActionItem>}
            </>
          )}
          {moreMenu.kind === 'workflow' && menuTarget && 'workflow' in menuTarget && (
            menuTarget.workflow.deleted ? (
              <>
                {can('workflow.edit') && <SidebarActionItem
                  icon="rotate-ccw"
                  onClick={() => { void restoreWorkflow(menuTarget.workflow.id, menuTarget.project.id); setMoreMenu(null) }}
                >
                  {t('layout.restoreFlow')}
                </SidebarActionItem>}
                {!menuTarget.workflow.is_default && can('workflow.delete') && (
                  <SidebarActionItem
                    icon="trash"
                    danger
                    onClick={() => { setDeleteWf({ id: menuTarget.workflow.id, projectId: menuTarget.project.id, name: menuTarget.workflow.name, soft: true }); setMoreMenu(null) }}
                  >
                    {t('nav.deletePermanent')}
                  </SidebarActionItem>
                )}
              </>
            ) : (
              <>
                {can('workflow.edit') && <SidebarActionItem
                  icon="pencil"
                  onClick={() => { setRenameWfId(menuTarget.workflow.id); setMoreMenu(null) }}
                >
                  {t('common.rename')}
                </SidebarActionItem>}
                {!menuTarget.workflow.is_default && can('workflow.delete') && menuTarget.project.workflows.filter((w) => !w.deleted).length > 1 && (
                  <SidebarActionItem
                    icon="trash"
                    danger
                    onClick={() => { setDeleteWf({ id: menuTarget.workflow.id, projectId: menuTarget.project.id, name: menuTarget.workflow.name, soft: false }); setMoreMenu(null) }}
                  >
                    {t('common.delete')}
                  </SidebarActionItem>
                )}
              </>
            )
          )}
        </SidebarActionMenu>
      )}

      {sessionMenu && (
        <SidebarActionMenu ref={sessionMenuRef} x={sessionMenu.x} y={sessionMenu.y}>
          <SidebarActionItem
            icon="archive"
            onClick={() => { void handleArchiveSession(sessionMenu.sessionId, sessionMenu.projectId) }}
          >
            {t('chatSession.archive')}
          </SidebarActionItem>
          <SidebarActionItem
            icon="pencil"
            onClick={() => {
              setRenameSessionId(sessionMenu.sessionId)
              setRenameSessionProjectId(sessionMenu.projectId)
              setRenameSessionValue(sessionMenu.title)
              setSessionMenu(null)
            }}
          >
            {t('common.rename')}
          </SidebarActionItem>
          <SidebarActionItem
            icon="trash"
            danger
            onClick={() => {
              clearSessionError()
              setDeleteSessionTarget(sessionMenu)
              setSessionMenu(null)
            }}
          >
            {t('common.delete')}
          </SidebarActionItem>
        </SidebarActionMenu>
      )}


      {renameSessionId && renameSessionProjectId && <ChatSessionRenameDialog
        projectId={renameSessionProjectId} sessionId={renameSessionId} title={renameSessionValue}
        onRenamed={() => { setRenameSessionId(null); setRenameSessionProjectId(null) }}
        onClose={() => { setRenameSessionId(null); setRenameSessionProjectId(null) }}
      />}

      <ConfirmDialog
        open={deleteSessionTarget !== null}
        title={t('chatSession.deleteTitle')}
        message={deleteSessionTarget ? t('chatSession.deleteMessage', { title: deleteSessionTarget.title }) : ''}
        confirmText={t('chatSession.deleteConfirm')}
        danger
        onConfirm={() => void handleDeleteSession()}
        onCancel={() => {
          setDeleteSessionTarget(null)
          clearSessionError()
        }}
      />
      {sessionDeleteError && (
        <div role="alert" className="layout-session-delete-error">
          <span>{sessionDeleteError}</span>
          <Button
            variant="icon"
            size="sm"
            aria-label={t('common.close')}
            onClick={clearSessionError}
            className="layout-session-delete-error-close"
          >
            <Icon name="x" size={13} />
          </Button>
        </div>
      )}

      {/* Main content */}
      <main className="app-main layout-main" data-ui="main">
        {children}
      </main>

      {!bound && showSettings && (
        <SettingsPage
          initialSection={settingsSection}
          focusTarget={settingsFocus}
          preferredProviderId={useOnboardingStore.getState().providerId}
          onConfigurationChanged={() => {
            void engineApi.executionConfig().then((config) => {
              if (config.engine) useOnboardingStore.getState().recordEngine(config.engine)
            }).catch(() => undefined)
          }}
          onClose={() => {
            setShowSettings(false)
            setSettingsFocus(undefined)
          }}
        />
      )}

      <LayoutOnboardingActions
        onOpenSettings={openOnboardingSettings}
        onOpenProject={openLocalProjectModal}
      />

      <ProjectConnectionDialog
        open={showInitModal}
        onClose={() => setShowInitModal(false)}
        onConnected={handleProjectConnected}
      />

      <ProjectShareDialog project={!isGatewayRemoteBrowser() ? shareProject : null}
        onClose={() => setShareProject(null)} />

      <WorkflowCreateDialog
        projectId={addWfProjectId}
        onClose={() => setAddWfProjectId(null)}
      />

      {/* Delete project confirm */}
      <ConfirmDialog
        open={deleteProjectTarget !== null}
        title={t('layout.deleteProjectTitle')}
        message={deleteProjectTarget
          ? `${t('layout.deleteProjectMessage', { name: deleteProjectTarget.name })}${deleteProjectError ? ` ${deleteProjectError}` : ''}`
          : undefined}
        confirmText={t('common.delete')}
        danger
        onConfirm={handleDeleteProject}
        onCancel={() => {
          setDeleteProjectTarget(null)
          setDeleteProjectError('')
        }}
      />

      {/* Delete workflow confirm */}
      <ConfirmDialog
        open={!!deleteWf}
        title={deleteWf?.soft ? t('layout.deleteFlowPermanentTitle') : t('layout.deleteFlowTitle')}
        message={deleteWf
          ? (deleteWf.soft
            ? t('layout.deleteFlowPermanentMessage', { name: deleteWf.name })
            : t('layout.deleteFlowSoftMessage', { name: deleteWf.name }))
          : undefined}
        confirmText={deleteWf?.soft ? t('nav.deletePermanent') : t('common.delete')}
        danger
        onConfirm={() => {
          if (deleteWf) deleteWorkflow(deleteWf.id, deleteWf.projectId)
          setDeleteWf(null)
        }}
        onCancel={() => setDeleteWf(null)}
      />

      {/* Unsaved canvas changes → switch workflow */}
      <ConfirmDialog
        open={!!pendingWfSwitch}
        title={t('canvas.unsavedTitle')}
        message={t('canvas.unsavedSwitchMessage')}
        confirmText={t('canvas.switch')}
        onConfirm={async () => {
          if (pendingWfSwitch) {
            const { project, workflowId } = pendingWfSwitch
            setActiveProject(project)
            await setActiveWorkflow(workflowId)
            navigate(taskListPath(project.name, workflowId))
          }
          setPendingWfSwitch(null)
        }}
        onCancel={() => setPendingWfSwitch(null)}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={bulkDeleteConfirm}
        title={t('chatSession.bulkDeleteTitle')}
        message={t('chatSession.bulkDeleteMessage', { count: selectedIds.size })}
        confirmText={t('common.delete')}
        danger
        loading={bulkDeleting}
        onConfirm={() => void handleBulkDelete()}
        onCancel={() => { setBulkDeleteConfirm(false); setBulkDeleteError('') }}
      >
        {bulkDeleteError && (
          <div className="layout-bulk-delete-error">
            {bulkDeleteError}
          </div>
        )}
      </ConfirmDialog>
    </div>
    </SkinWorkspaceFrame>
  )
}
