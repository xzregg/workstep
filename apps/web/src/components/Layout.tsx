import { useVisualViewport } from '../hooks/useVisualViewport'
import Icon from './Icon'
import ResponsiveNavigation from './ResponsiveNavigation'
import { BrandIcon } from './BrandIcon'
import { useState, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import SessionRowActions from './SessionRowActions'
import { useTaskStore } from '../stores/taskStore'
import { useChatListStore } from '../stores/chatSessionStore'
import { useSidebarActivityStore } from '../stores/sidebarActivityStore'
import { useSidebarActivity } from '../hooks/useSidebarActivity'
import { useWebSocket } from '../hooks/useWebSocket'
import { taskListPath } from '../hooks/useTaskRoute'
import { useProjectRouteSelection } from '../hooks/useProjectRouteSelection'
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
import { loadSidebarSectionState, saveSidebarSectionState } from '../utils/sidebarSectionState'
import LayoutOnboardingActions from './LayoutOnboardingActions'
import SidebarRenameField from './SidebarRenameField'
import { SidebarActionItem, SidebarActionMenu } from './SidebarActionMenu'
import { useOnboardingStore } from '../stores/onboardingStore'
import { filterSidebarProject } from '../utils/sidebarSearch'
import { useSidebarSessionActions } from '../hooks/useSidebarSessionActions'
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
  useWebSocket()
  useVisualViewport()
  const navigate = useNavigate()
  const location = useLocation()
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
  const [showInitModal, setShowInitModal] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('providers')
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocusTarget | undefined>()
  const [addWfProjectId, setAddWfProjectId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(280)
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
  const renameSessionInputRef = useRef<HTMLInputElement>(null)
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
    renameSession,
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
  const visibleProjects = sidebarSearchActive
    ? projects.filter((project) => sidebarSearchResults.get(project.id)?.visible)
    : projects
  const previousSessionProjectIdsRef = useRef(new Set<string>())
  const sessionProjectIdsKey = [...new Set([
    ...expandedProjectIds,
    ...(activeProject?.id ? [activeProject.id] : []),
  ])]
    .filter((projectId) => projects.some((project) => project.id === projectId))
    .sort()
    .join('\u0000')
  const startSidebarDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(Math.min(480, Math.max(180, startWidth + (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = ''
  }

  useEffect(() => { fetchProjects() }, [fetchProjects])

  useEffect(() => {
    saveSidebarSectionState({
      expandedProjectIds,
      flowsByProject: flowSectionOpen,
      conversationsByProject: sessionSectionOpen,
    })
  }, [expandedProjectIds, flowSectionOpen, sessionSectionOpen])

  useEffect(() => {
    if (renameSessionId) {
      const t = setTimeout(() => renameSessionInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [renameSessionId])

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
    const sessionProjectIds = new Set(
      sessionProjectIdsKey ? sessionProjectIdsKey.split('\u0000') : [],
    )
    for (const projectId of sessionProjectIds) {
      if (!previousSessionProjectIdsRef.current.has(projectId)) {
        void useChatListStore.getState().fetchSessions(projectId)
      }
    }
    previousSessionProjectIdsRef.current = sessionProjectIds
  }, [sessionProjectIdsKey])

  useEffect(() => {
    if (!sidebarSearchOpen) return
    const timer = window.setTimeout(() => sidebarSearchInputRef.current?.focus(), 0)
    for (const project of projects) {
      if (!(project.id in sessionsByProject)) {
        void useChatListStore.getState().fetchSessions(project.id)
      }
    }
    return () => window.clearTimeout(timer)
  }, [projects, sessionsByProject, sidebarSearchOpen])

  const handleSelectProject = (p: Project) => {
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

  const openAddWorkflow = (projectId: string) => setAddWfProjectId(projectId)

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

  const handleRenameSession = async (sessionId: string, title: string, projectId?: string) => {
    const ownerProjectId = projectId || renameSessionProjectId || activeProject?.id
    if (ownerProjectId) await renameSession(sessionId, ownerProjectId, title)
    setRenameSessionId(null)
    setRenameSessionProjectId(null)
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
    <div className="app-shell">
      {/* Sidebar */}
      <ResponsiveNavigation className="layout-sidebar" newDisabled={!activeProject} dismissSignal={`${showSettings}:${showInitModal}:${addWfProjectId}`} title={activeProject?.name || "WorkStep"} onNew={() => navigate(`/chat?project=${encodeURIComponent(activeProject?.name || "")}`)} style={{ width: sidebarWidth }}>
        <div className="layout-sidebar-header">
          <div className="layout-sidebar-brand">
            <BrandIcon size={18} />
            WorkStep
            <a
              href="/landing"
              className="layout-sidebar-intro"
            >
              {t('layout.intro')}
            </a>
          </div>
        </div>

        <Button
          variant="ghost"
          onClick={() => navigate('/statistics')}
          aria-current={location.pathname === '/statistics' ? 'page' : undefined}
          className="layout-sidebar-nav-button"
        >
          <Icon name="bar-chart" size={17} strokeWidth={2} />
          {t('nav.statistics')}
        </Button>

        <Button variant="ghost" className="layout-sidebar-nav-button" onClick={openLocalProjectModal}>
          <Icon name="plus" size={17} strokeWidth={2} />
          {t('nav.addProject')}
        </Button>

        <div className="layout-sidebar-section-label">
          <span>{t('layout.projects')}</span>
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
        </div>

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
                draggable={p.type === 'local' && renameId !== p.path}
                onDragStart={(e) => {
                  e.stopPropagation()
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', p.id)
                  setDragProjectId(p.id)
                }}
                onDragOver={(e) => {
                  if (p.type !== 'local') return
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
                  if (p.type !== 'local') return
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
                    onSave={(name) => renameProject(p.path, name)}
                    onClose={() => setRenameId(null)}
                  />
                ) : (
                  <span className="layout-project-name">
                    {p.name}
                    {p.type === 'remote' && (
                      <span
                        title={p.access_status === 'revoked'
                          ? t('layout.remoteAccessRevoked')
                          : p.access_status === 'expired'
                            ? t('layout.remoteAccessExpired')
                            : p.endpoint}
                        className="layout-project-remote-badge"
                        data-access-status={p.access_status}
                      >
                        {p.access_status === 'revoked'
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
                <Button
                  variant="icon"
                  className="ws-more-btn"
                  onClick={(e) => openMoreMenu(e, 'project', p.id)}
                  title={t('layout.moreActions')}
                  aria-label={t('layout.moreActions')}
                >⋯</Button>
              </div>

              {/* Workflow list + sessions under the selected project */}
              {isProjectExpanded(p.id) && (
                <div id={`sidebar-project-${p.id}`}>
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
                          {flowOpen && (
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
                      draggable={renameWfId !== wf.id}
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
                          onDoubleClick={(e) => { e.stopPropagation(); if (!deleted) setRenameWfId(wf.id) }}
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
                      <Button
                        variant="icon"
                        className="ws-more-btn"
                        onClick={(e) => openMoreMenu(e, 'workflow', wf.id)}
                        title={t('layout.moreActions')}
                        aria-label={t('layout.moreActions')}
                      >⋯</Button>
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
                return (
                  <>
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
                      {open && (
                        <SidebarAddButton
                          loading={creatingSession}
                          disabled={creatingSession}
                          onClick={(e) => { e.stopPropagation(); void createSession(p) }}
                          title={t('chatSession.newSession')}
                          aria-label={t('chatSession.newSession')}
                            />
                      )}
                    </div>
                    {open && (
                    <div className="layout-session-list">
                      {/* Bulk action bar (visible when 2+ sessions selected) */}
                      {selectionProjectId === p.id && selectedIds.size >= 2 && (
                        <div className="layout-session-bulk-actions">
                          <span className="layout-session-bulk-count">{t('chatSession.selectedCount', { count: selectedIds.size })}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={bulkDeleting}
                            disabled={bulkDeleting}
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
                      {searchResult.sessions.map(session => {
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
                              navigate(`/chat?project=${encodeURIComponent(p.name)}&session=${encodeURIComponent(session.id)}`)
                            }
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
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
                          draggable={renameSessionId !== session.id && !isMultiSelect}
                          onDragStart={(e) => {
                            e.stopPropagation()
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', session.id)
                            setDragSessionId(session.id)
                          }}
                          onDragOver={(e) => {
                            if (isMultiSelect) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dropSessionId !== session.id) setDropSessionId(session.id)
                          }}
                          onDragLeave={(e) => {
                            e.stopPropagation()
                            if (dropSessionId === session.id) setDropSessionId(null)
                          }}
                          onDrop={(e) => {
                            if (isMultiSelect) return
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
                          {renameSessionId === session.id ? (
                            <Input
                              ref={renameSessionInputRef}
                              value={renameSessionValue}
                              onChange={(e) => setRenameSessionValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { void handleRenameSession(session.id, renameSessionValue, p.id) }
                                if (e.key === 'Escape') { setRenameSessionId(null); setRenameSessionProjectId(null) }
                              }}
                              onBlur={() => { if (renameSessionId === session.id) void handleRenameSession(session.id, renameSessionValue, p.id) }}
                              onClick={(e) => e.stopPropagation()}
                              className="layout-session-rename-input"
                            />
                          ) : (
                            <MarqueeText text={session.title} />
                          )}
                          <SidebarStatusIndicator
                            running={sessionRunning}
                            failed={failedChatSessions[session.id]}
                            completed={Boolean(completedSessions[session.id])}
                            runningTitle={t('chatSession.runningHint')}
                            failedTitle={t('layout.failedState')}
                            completedTitle={t('layout.completedUnread')}
                          />
                          <SessionRowActions
                            session={session}
                            hovered={hoveredSessionId === session.id}
                            now={sidebarNow}
                            onArchive={() => { void handleArchiveSession(session.id, p.id) }}
                            onMore={(e) => openSessionMenu(e, p.id, session.id, session.title)}
                          />
                        </div>
                        )
                      })}
                    </div>
                    )}
                  </>
                )
              })()}
                </div>
              )}
            </div>
            )
          })}
          {projects.length === 0 && (
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

        <Button
          variant="ghost"
          onClick={() => { setSettingsSection('providers'); setSettingsFocus(undefined); setShowSettings(true) }}
          aria-current={showSettings ? 'page' : undefined}
          className="layout-sidebar-nav-button layout-sidebar-settings-button"
        >
          <Icon name="settings" size={17} strokeWidth={2} />
          {t('nav.settings')}
        </Button>
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
          setSidebarWidth((w) => Math.min(480, Math.max(180, w + (e.key === 'ArrowLeft' ? -16 : 16))))
        }}
      />

      {moreMenu && (
        <SidebarActionMenu ref={moreMenuRef} x={moreMenu.x} y={moreMenu.y}>
          {moreMenu.kind === 'project' && menuTarget && 'path' in menuTarget && (
            <>
              {menuTarget.type !== 'remote' && (
                <SidebarActionItem
                  icon="pencil"
                  onClick={() => { setRenameId(menuTarget.path); setMoreMenu(null) }}
                >
                  {t('common.rename')}
                </SidebarActionItem>
              )}
              <SidebarActionItem
                icon="plus"
                onClick={() => { openAddWorkflow(menuTarget.id); setMoreMenu(null) }}
              >
                {t('layout.addWorkflowTitle')}
              </SidebarActionItem>
              <SidebarActionItem
                icon="bot"
                onClick={() => {
                  setMoreMenu(null)
                  void createSession(menuTarget)
                }}
              >
                {t('chatSession.addSessionTitle')}
              </SidebarActionItem>
              {menuTarget.type !== 'remote' && (
                <SidebarActionItem
                  icon="share"
                  onClick={() => { setShareProject(menuTarget); setMoreMenu(null) }}
                >
                  {t('layout.remoteShareTitle')}
                </SidebarActionItem>
              )}
              <SidebarActionItem
                icon="trash"
                danger
                onClick={() => { setDeleteProjectError(''); setDeleteProjectTarget(menuTarget); setMoreMenu(null) }}
              >
                {t('layout.deleteProjectTitle')}
              </SidebarActionItem>
            </>
          )}
          {moreMenu.kind === 'workflow' && menuTarget && 'workflow' in menuTarget && (
            menuTarget.workflow.deleted ? (
              <>
                <SidebarActionItem
                  icon="rotate-ccw"
                  onClick={() => { void restoreWorkflow(menuTarget.workflow.id, menuTarget.project.id); setMoreMenu(null) }}
                >
                  {t('layout.restoreFlow')}
                </SidebarActionItem>
                {!menuTarget.workflow.is_default && (
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
                <SidebarActionItem
                  icon="pencil"
                  onClick={() => { setRenameWfId(menuTarget.workflow.id); setMoreMenu(null) }}
                >
                  {t('common.rename')}
                </SidebarActionItem>
                {!menuTarget.workflow.is_default && menuTarget.project.workflows.filter((w) => !w.deleted).length > 1 && (
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
      <main className="app-main layout-main">
        {children}
      </main>

      {showSettings && (
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

      <ProjectShareDialog project={shareProject} onClose={() => setShareProject(null)} />

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
  )
}
