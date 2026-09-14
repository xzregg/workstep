import { useVisualViewport } from '../hooks/useVisualViewport'
import Icon from './Icon'
import ResponsiveNavigation from './ResponsiveNavigation'
import { BrandIcon } from './BrandIcon'
import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import { formatRelativeTime, formatConversationDateTime } from '../utils/datetime'
import { useTaskStore } from '../stores/taskStore'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
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
import OnboardingChecklist from './OnboardingChecklist'
import { useOnboardingStore } from '../stores/onboardingStore'
import { buildStarterWorkflow } from '../utils/onboarding'
import {
  fetchEngineModels,
  chatSessionApi,
  type Project,
} from '../api/client'

function SidebarAddButton(props: ButtonProps) {
  return (
    <Button {...props} variant="icon" size="sm" className="sidebar-add-button">
      <Icon name="plus" size={9.6} strokeWidth={2} />
    </Button>
  )
}

const sidebarStyle: React.CSSProperties = {
  width: 280, minWidth: 280,
  background: 'var(--bg)',
  borderRight: '1px solid var(--border-soft)',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
}

const sectionLabel: React.CSSProperties = {
  padding: '14px 14px 6px',
  fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600,
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  display: 'flex', alignItems: 'center',
  justifyContent: 'space-between',
}

const nestedSectionLabel: React.CSSProperties = {
  margin: '10px 12px 2px 28px',
  fontSize: 'calc(14px * var(--font-scale))', fontWeight: 600,
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  display: 'flex', alignItems: 'center',
  justifyContent: 'space-between',
  paddingRight: 6,
}

const projectItemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '9px 12px', borderRadius: 10,
  cursor: 'pointer', fontSize: 'calc(14px * var(--font-scale))',
  color: active ? 'var(--fg)' : 'var(--fg-2)',
  background: active ? 'var(--surface)' : 'transparent',
  fontWeight: active ? 500 : 400,
  marginBottom: 2,
  transition: 'all var(--motion-fast)',
})

const addButtonStyle: React.CSSProperties = {
  margin: '10px 12px 0', width: 'calc(100% - 24px)', height: 36,
  padding: '0 10px', justifyContent: 'flex-start', gap: 9,
  borderRadius: 9, fontSize: 'calc(13px * var(--font-scale))',
  color: 'var(--fg-2)', background: 'transparent',
}

const hasWhitespace = (s: string) => /\s/.test(s)

interface Props {
  onSelectProject: (p: Project) => void
  children: React.ReactNode
}

export default function Layout({ onSelectProject, children }: Props) {
  const { t, locale } = useI18n()
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
  // 悬停会话行时，右侧的相对时间就地切换为 ⋯ 菜单按钮
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const { projects, activeProject, activeWorkflowId, fetchProjects, setActiveProject, renameProject, deleteProject, renameWorkflow, createWorkflow, deleteWorkflow, restoreWorkflow, reorderProjects, reorderWorkflows, setActiveWorkflow } = useProjectStore()
  const [showInitModal, setShowInitModal] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('providers')
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocusTarget | undefined>()
  const onboardingStatus = useOnboardingStore((state) => state.status)
  const [onboardingRefreshToken, setOnboardingRefreshToken] = useState(0)
  const [onboardingWorkflowBusy, setOnboardingWorkflowBusy] = useState(false)
  const [onboardingError, setOnboardingError] = useState('')
  const [addWfProjectId, setAddWfProjectId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [renameWfId, setRenameWfId] = useState<string | null>(null)
  const [renameWfName, setRenameWfName] = useState('')
  const [deleteWf, setDeleteWf] = useState<{ id: string; projectId: string; name: string; soft: boolean } | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [deleteProjectError, setDeleteProjectError] = useState('')
  const [shareProject, setShareProject] = useState<Project | null>(null)
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ kind: 'project' | 'workflow'; id: string; x: number; y: number } | null>(null)
  const [dragProjectId, setDragProjectId] = useState<string | null>(null)
  const [dropProjectId, setDropProjectId] = useState<string | null>(null)
  const sessions = useChatListStore((s) => s.sessions)
  const tasks = useTaskStore((s) => s.tasks)
  const selectedIds = useChatListStore((s) => s.selectedIds)
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
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameWfInputRef = useRef<HTMLInputElement>(null)
  const renameSessionInputRef = useRef<HTMLInputElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; sessionId: string; title: string } | null>(null)
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null)
  const [renameSessionValue, setRenameSessionValue] = useState('')
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{ sessionId: string; title: string } | null>(null)
  const [sessionDeleteError, setSessionDeleteError] = useState('')
  const [storedSidebarSections] = useState(loadSidebarSectionState)
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(
    storedSidebarSections.expandedProjectId,
  )
  const [sessionSectionOpen, setSessionSectionOpen] = useState<Record<string, boolean>>(
    storedSidebarSections.conversationsByProject,
  )
  const [flowSectionOpen, setFlowSectionOpen] = useState<Record<string, boolean>>(
    storedSidebarSections.flowsByProject,
  )
  const [creatingSession, setCreatingSession] = useState(false)
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
      expandedProjectId,
      flowsByProject: flowSectionOpen,
      conversationsByProject: sessionSectionOpen,
    })
  }, [expandedProjectId, flowSectionOpen, sessionSectionOpen])

  // Re-focus inputs each time they open (autoFocus only fires on first mount)
  useEffect(() => {
    if (renameId) {
      const t = setTimeout(() => renameInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [renameId])

  useEffect(() => {
    if (renameWfId) {
      const t = setTimeout(() => renameWfInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [renameWfId])

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
      setProjectContextMenu(null)
      setMoreMenu(null)
      setSessionMenu(null)
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (projectMenuRef.current?.contains(target)) return
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
      (project) => project.id === storedSidebarSections.expandedProjectId,
    )
    if (rememberedProject) setActiveProject(rememberedProject)
  }, [projectName, projects, activeProject, setActiveProject, storedSidebarSections.expandedProjectId])

  useEffect(() => {
    if (activeProject?.id) setExpandedProjectId(activeProject.id)
  }, [activeProject?.id])

  const handleSelectProject = (p: Project) => {
    setExpandedProjectId(p.id)
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
    if (!activeProject?.id) return
    try {
      await bulkRemove(activeProject.id)
      setBulkDeleteError('')
    } catch {
      setBulkDeleteError(t('chatSession.deleteFailed'))
    }
    setBulkDeleteConfirm(false)
  }

  const openMoreMenu = (e: React.MouseEvent, kind: 'project' | 'workflow', id: string) => {
    e.stopPropagation()
    setProjectContextMenu(null)
    setSessionMenu(null)
    const rect = e.currentTarget.getBoundingClientRect()
    const atCursor = e.type === 'contextmenu'
    setMoreMenu({
      kind,
      id,
      x: Math.min(atCursor ? e.clientX : rect.left, window.innerWidth - 176),
      y: Math.min(atCursor ? e.clientY : rect.bottom + 4, window.innerHeight - 128),
    })
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
      && onboarding.currentStep === 'project'
    ) {
      onboarding.recordProject(project.id)
      setOnboardingRefreshToken((value) => value + 1)
    }
    onSelectProject(project)
  }

  const openOnboardingSettings = (section: SettingsSection, focus: SettingsFocusTarget) => {
    setSettingsSection(section)
    setSettingsFocus(focus)
    setOnboardingError('')
    setShowSettings(true)
  }

  const openOnboardingProject = () => {
    setOnboardingError('')
    openLocalProjectModal()
  }

  const createOnboardingWorkflow = async () => {
    const onboarding = useOnboardingStore.getState()
    const project = projects.find((item) => item.id === onboarding.projectId && item.type !== 'remote')
    if (!project || !onboarding.engineId || onboardingWorkflowBusy) return
    setOnboardingWorkflowBusy(true)
    setOnboardingError('')
    try {
      let model = ''
      try {
        const result = await fetchEngineModels(onboarding.engineId, false, onboarding.providerId || '', project.id)
        model = result.default_model || ''
      } catch {
        // The engine may validly use its own implicit default model.
      }
      setActiveProject(project)
      const workflow = await createWorkflow(
        project.id,
        '分析与执行',
        undefined,
        buildStarterWorkflow(onboarding.engineId, model),
      )
      onboarding.recordWorkflow(workflow.id)
      await fetchProjects()
      const refreshedProject = useProjectStore.getState().projects.find((item) => item.id === project.id)
      if (refreshedProject) setActiveProject(refreshedProject)
      await setActiveWorkflow(workflow.id)
      setOnboardingRefreshToken((value) => value + 1)
      navigate(`/canvas?project=${encodeURIComponent(project.name)}&workflow=${encodeURIComponent(workflow.id)}&onboarding=1`)
    } catch (reason) {
      setOnboardingError(reason instanceof Error ? reason.message : t('onboarding.createWorkflowFailed'))
    } finally {
      setOnboardingWorkflowBusy(false)
    }
  }

  const openOnboardingTask = () => {
    const onboarding = useOnboardingStore.getState()
    const project = projects.find((item) => item.id === onboarding.projectId)
    if (!project || !onboarding.workflowId) return
    setActiveProject(project)
    void setActiveWorkflow(onboarding.workflowId)
    navigate(`/tasks?project=${encodeURIComponent(project.name)}&onboarding=create-task`)
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

  const openSessionMenu = (e: React.MouseEvent, sessionId: string, title: string) => {
    e.preventDefault()
    e.stopPropagation()
    setProjectContextMenu(null)
    setMoreMenu(null)
    const rect = e.currentTarget.getBoundingClientRect()
    const atCursor = e.type === 'contextmenu'
    setSessionMenu({
      x: Math.min(atCursor ? e.clientX : rect.left, window.innerWidth - 176),
      y: Math.min(atCursor ? e.clientY : rect.bottom + 4, window.innerHeight - 128),
      sessionId,
      title,
    })
  }

  const handleCreateSession = async (project: Project) => {
    if (creatingSession) return
    setCreatingSession(true)
    try {
      const detail = await chatSessionApi.create({
        project_id: project.id,
      })
      useChatListStore.getState().addSession({
        id: detail.id,
        project_id: detail.project_id,
        workflow_id: detail.workflow_id,
        title: detail.title,
        engine: detail.engine,
        model: detail.model,
        message_count: detail.message_count,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
      })
      navigate(`/chat?project=${encodeURIComponent(project.name)}&session=${encodeURIComponent(detail.id)}`)
    } catch {
      // Errors surface on the chat page itself.
    } finally {
      setCreatingSession(false)
    }
  }

  const handleRenameSession = async (sessionId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) { setRenameSessionId(null); return }
    if (!activeProject?.id) { setRenameSessionId(null); return }
    try {
      const updated = await chatSessionApi.rename(sessionId, activeProject.id, trimmed)
      useChatListStore.getState().renameSession(sessionId, updated.title)
    } catch {
      // Keep the old title on failure.
    }
    setRenameSessionId(null)
  }

  const handleDeleteSession = async () => {
    if (!deleteSessionTarget || !activeProject?.id) return
    setSessionDeleteError('')
    try {
      await chatSessionApi.remove(deleteSessionTarget.sessionId, activeProject.id)
      useChatListStore.getState().removeSession(deleteSessionTarget.sessionId)
      useChatSessionStore.getState().resetSession(deleteSessionTarget.sessionId)
      if (activeSessionId === deleteSessionTarget.sessionId) {
        const remaining = useChatListStore.getState().sessions
        const next = remaining[0]
        if (next) {
          navigate(`/chat?project=${encodeURIComponent(activeProject.name)}&session=${encodeURIComponent(next.id)}`, { replace: true })
        } else {
          navigate(`/chat?project=${encodeURIComponent(activeProject.name)}`, { replace: true })
        }
      }
      setDeleteSessionTarget(null)
    } catch (reason) {
      setSessionDeleteError(reason instanceof Error ? reason.message : t('chatSession.deleteFailed'))
    }
  }

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <ResponsiveNavigation newDisabled={!activeProject} dismissSignal={`${showSettings}:${showInitModal}:${addWfProjectId}`} title={activeProject?.name || "WorkStep"} onNew={() => navigate(`/chat?project=${encodeURIComponent(activeProject?.name || "")}`)} style={{ ...sidebarStyle, width: sidebarWidth, minWidth: 180 }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))', fontFamily: 'var(--font-display)' }}>
            <BrandIcon size={18} />
            WorkStep
            <a
              href="/landing"
              style={{
                marginLeft: 'auto',
                padding: '2px 8px',
                fontSize: 'calc(11px * var(--font-scale))',
                fontWeight: 500,
                borderRadius: 6,
                color: 'var(--fg-2)',
                textDecoration: 'none',
                fontFamily: 'var(--font-body)',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--accent)'
                e.currentTarget.style.background = 'var(--surface)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--fg-2)'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {t('layout.intro')}
            </a>
          </div>
        </div>

        <Button
          variant="ghost"
          onClick={() => navigate('/statistics')}
          aria-current={location.pathname === '/statistics' ? 'page' : undefined}
          style={{
            margin: '10px 12px 0', width: 'calc(100% - 24px)', height: 36,
            padding: '0 10px', justifyContent: 'flex-start', gap: 9,
            borderRadius: 9, fontSize: 'calc(13px * var(--font-scale))',
            color: location.pathname === '/statistics' ? 'var(--fg)' : 'var(--fg-2)',
            background: location.pathname === '/statistics' ? 'var(--surface)' : 'transparent',
          }}
        >
          <Icon name="bar-chart" size={17} strokeWidth={2} />
          {t('nav.statistics')}
        </Button>

        <Button variant="ghost" style={addButtonStyle} onClick={openLocalProjectModal}>
          <Icon name="plus" size={17} strokeWidth={2} />
          {t('nav.addProject')}
        </Button>

        <div style={sectionLabel}>{t('layout.projects')}</div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
          {projects.map((p) => (
            <div key={p.id}>
              <div
                onClick={() => {
                  markProjectRead(p.id)
                  handleSelectProject(p)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setExpandedProjectId((current) => current === p.id ? null : p.id)
                  if (expandedProjectId !== p.id) {
                    markProjectRead(p.id)
                    handleSelectProject(p)
                  }
                }}
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
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMoreMenu(null)
                  setSessionMenu(null)
                  setProjectContextMenu({
                    x: e.clientX,
                    y: Math.min(e.clientY, window.innerHeight - 48),
                    project: p,
                  })
                }}
                className="ws-row"
                style={{
                  ...projectItemStyle(activeProject?.id === p.id),
                  position: 'relative',
                  opacity: dragProjectId === p.id ? 0.4 : 1,
                  outline: dropProjectId === p.id ? '1px solid var(--accent)' : 'none',
                  ...(dropProjectId === p.id ? { background: 'var(--accent-light)' } : {}),
                }}
              >

                <Button
                  variant="icon"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpandedProjectId((current) => current === p.id ? null : p.id)
                    if (expandedProjectId !== p.id) {
                      markProjectRead(p.id)
                      handleSelectProject(p)
                    }
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-expanded={expandedProjectId === p.id}
                  aria-controls={`sidebar-project-${p.id}`}
                  aria-label={t(expandedProjectId === p.id ? 'layout.collapseProject' : 'layout.expandProject', { name: p.name })}
                  title={t(expandedProjectId === p.id ? 'layout.collapseProject' : 'layout.expandProject', { name: p.name })}
                  style={{ width: 20, height: 20, padding: 0, flexShrink: 0, color: expandedProjectId === p.id ? 'var(--accent)' : 'var(--meta)' }}
                >
                  <Icon
                    name={p.type === 'remote' ? 'external-link' : expandedProjectId === p.id ? 'folder-open' : 'folder'} size={16.4} strokeWidth={2}
                  />
                </Button>
                {renameId === p.path ? (
                  <Input
                    ref={renameInputRef}
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && renameName.trim()) {
                        if (hasWhitespace(renameName)) {
                          setRenameError(t('layout.nameWhitespace'))
                          return
                        }
                        await renameProject(p.path, renameName.trim())
                        setRenameId(null)
                      }
                      if (e.key === 'Escape') { setRenameId(null); setRenameError('') }
                    }}
                    onBlur={async () => {
                      if (renameName.trim() && renameName !== p.name) {
                        if (hasWhitespace(renameName)) {
                          setRenameError(t('layout.nameWhitespace'))
                          setRenameId(null)
                          return
                        }
                        await renameProject(p.path, renameName.trim())
                      }
                      setRenameId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    style={{ flex: 1, height: 30, fontSize: 'calc(14px * var(--font-scale))', padding: '0 4px', border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                  />
                ) : (
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                    {p.type === 'remote' && (
                      <span
                        title={p.access_status === 'revoked'
                          ? t('layout.remoteAccessRevoked')
                          : p.access_status === 'expired'
                            ? t('layout.remoteAccessExpired')
                            : p.endpoint}
                        style={{
                          display: 'inline-block',
                          marginLeft: 6,
                          padding: '0 4px',
                          borderRadius: 3,
                          background: 'var(--surface)',
                          color: p.access_status === 'revoked'
                            ? 'var(--danger)'
                            : p.access_status === 'expired'
                              ? 'var(--status-paused)'
                              : 'var(--meta)',
                          fontSize: 'calc(10px * var(--font-scale))',
                          lineHeight: '16px',
                          verticalAlign: 1,
                        }}
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
                {expandedProjectId !== p.id && (() => {
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
                ) : expandedProjectId !== p.id ? (
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
                  style={{ width: 20, height: 20, borderRadius: 4, background: 'transparent', color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: '18px', padding: 0, flexShrink: 0 }}
                >⋯</Button>
              </div>

              {renameId === p.path && renameError && (
                <div style={{ marginLeft: 38, marginBottom: 4, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--danger)' }}>{renameError}</div>
              )}

              {/* Workflow list + sessions under the selected project */}
              {expandedProjectId === p.id && (
                <div id={`sidebar-project-${p.id}`}>
                  {(() => {
                    const flowOpen = flowSectionOpen[p.id] !== false
                    return (
                      <>
                        <div
                          style={{ ...nestedSectionLabel, cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setFlowSectionOpen((prev) => ({ ...prev, [p.id]: !flowOpen }))
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Icon
                              name={flowOpen ? 'folder-open' : 'folder'} size={14} strokeWidth={2}
                              style={{ flexShrink: 0, color: flowOpen ? 'var(--accent)' : 'var(--meta)' }}
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
                        {flowOpen && (p.workflows || []).map(wf => (
                (() => {
                  const deleted = !!wf.deleted
                  const isDragSource = dragWfId === wf.id
                  const isDropTarget = dropWfId === wf.id
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
                      className="ws-row"
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
                      style={{
                        marginLeft: 28, padding: '4px 10px', borderRadius: 6,
                        cursor: deleted ? 'default' : 'pointer',
                        fontSize: 'calc(14px * var(--font-scale))',
                        color: deleted ? 'var(--meta)' : (activeProject?.id === p.id && activeWorkflowId === wf.id ? 'var(--accent)' : 'var(--meta)'),
                        background: isDropTarget
                          ? 'var(--accent-light)'
                          : activeProject?.id === p.id && activeWorkflowId === wf.id ? 'var(--accent-light)' : 'transparent',
                        opacity: isDragSource ? 0.4 : 1,
                        outline: isDropTarget ? '1px solid var(--accent)' : 'none',
                        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1,
                      }}
                    >
                      <Icon name="workflow" size={12.8} strokeWidth={2} />
                      {renameWfId === wf.id ? (
                        <Input
                          ref={renameWfInputRef}
                          value={renameWfName}
                          onChange={(e) => setRenameWfName(e.target.value)}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && renameWfName.trim() && !hasWhitespace(renameWfName)) {
                              try { await renameWorkflow(wf.id, p.id, renameWfName.trim()) } catch {}
                              setRenameWfId(null)
                            }
                            if (e.key === 'Escape') setRenameWfId(null)
                          }}
                          onBlur={async () => {
                            if (renameWfName.trim() && renameWfName !== wf.name && !hasWhitespace(renameWfName)) {
                              try { await renameWorkflow(wf.id, p.id, renameWfName.trim()) } catch {}
                            }
                            setRenameWfId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flex: 1, height: 28, fontSize: 'calc(14px * var(--font-scale))', padding: '0 4px', border: `1px solid ${hasWhitespace(renameWfName) ? 'var(--danger)' : 'var(--accent)'}`, borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                        />
                      ) : (
                        <MarqueeText
                          text={wf.name}
                          onDoubleClick={(e) => { e.stopPropagation(); if (!deleted) { setRenameWfId(wf.id); setRenameWfName(wf.name) } }}
                          style={{ textDecoration: deleted ? 'line-through' : 'none', opacity: deleted ? 0.6 : 1, cursor: deleted ? 'default' : 'pointer' }}
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
                      {deleted && <span style={{ fontSize: 'calc(11.6px * var(--font-scale))', color: 'var(--danger)', opacity: 0.8 }}>{t('layout.trash')}</span>}
                      {wf.is_default ? <span style={{ fontSize: 'calc(11.6px * var(--font-scale))', opacity: 0.6 }}>{t('layout.default')}</span> : null}
                      <span style={{ fontSize: 'calc(11.6px * var(--font-scale))', opacity: 0.5 }}>{t('flow.nodeCount', { count: wf.nodeCount })}</span>
                      <Button
                        variant="icon"
                        className="ws-more-btn"
                        onClick={(e) => openMoreMenu(e, 'workflow', wf.id)}
                        title={t('layout.moreActions')}
                        aria-label={t('layout.moreActions')}
                        style={{ width: 28, height: 28, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--meta)', fontSize: 'calc(14px * var(--font-scale))', lineHeight: '26px', padding: 0, flexShrink: 0 }}
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
                const open = sessionSectionOpen[p.id]
                  ?? (location.pathname === '/chat' && !!activeSessionId)
                return (
                  <>
                    <div
                      style={{
                        ...nestedSectionLabel,
                        cursor: 'pointer',                        margin: '14px 12px 2px 28px',
                        padding: '10px 6px 0 0',
                        borderTop: '1px solid var(--border-soft)',
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSessionSectionOpen((prev) => ({ ...prev, [p.id]: !open }))
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Icon
                          name={open ? 'folder-open' : 'folder'} size={14} strokeWidth={2}
                          style={{ flexShrink: 0, color: open ? 'var(--accent)' : 'var(--meta)' }}
                        />
                        {t('chatSession.navSection')}
                      </span>
                      {open && (
                        <SidebarAddButton
                          loading={creatingSession}
                          disabled={creatingSession}
                          onClick={(e) => { e.stopPropagation(); void handleCreateSession(p) }}
                          title={t('chatSession.newSession')}
                          aria-label={t('chatSession.newSession')}
                            />
                      )}
                    </div>
                    {open && (
                    <div style={{ margin: '0 12px 6px 28px', display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {/* Bulk action bar (visible when 2+ sessions selected) */}
                      {selectedIds.size >= 2 && (
                        <div
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '4px 8px', marginBottom: 2,
                            background: 'var(--accent-light)', borderRadius: 6,
                            fontSize: 'calc(11.6px * var(--font-scale))', color: 'var(--accent)',
                          }}
                        >
                          <span style={{ flex: 1 }}>{t('chatSession.selectedCount', { count: selectedIds.size })}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={bulkDeleting}
                            disabled={bulkDeleting}
                            onClick={(e) => { e.stopPropagation(); setBulkDeleteError(''); setBulkDeleteConfirm(true) }}
                            title={t('chatSession.bulkDelete')}
                            style={{ width: 20, height: 20, padding: '4px', borderRadius: 4, background: 'transparent', color: 'var(--danger)', flexShrink: 0 }}
                          >
                            <Icon name="trash" size={10} strokeWidth={2} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => { e.stopPropagation(); clearSelection() }}
                            title={t('chatSession.deselectAll')}
                            style={{ width: 20, height: 20, padding: '4px', borderRadius: 4, background: 'transparent', color: 'var(--meta)', flexShrink: 0 }}
                          >
                            <Icon name="x" size={10} strokeWidth={2} />
                          </Button>
                        </div>
                      )}
                      {sessions.map(session => {
                        const isDragSource = dragSessionId === session.id
                        const isDropTarget = dropSessionId === session.id
                        const sessionRunning = Boolean(runningChatSessions[session.id])
                        const isSelected = selectedIds.has(session.id)
                        const isMultiSelect = selectedIds.size > 1
                        return (
                        <div
                          key={session.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (renameSessionId === session.id) return
                            handleSelect(session.id, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })
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
                            setRenameSessionValue(session.title)
                          }}
                          onContextMenu={(e) => openSessionMenu(e, session.id, session.title)}
                          onMouseEnter={() => setHoveredSessionId(session.id)}
                          onMouseLeave={() => setHoveredSessionId(null)}
                          className="ws-row"
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
                            const ids = sessions.map((item) => item.id)
                            if (!ids.includes(dragId) || !ids.includes(targetId)) return
                            const rect = e.currentTarget.getBoundingClientRect()
                            const before = e.clientY < rect.top + rect.height / 2
                            const next = ids.filter((id) => id !== dragId)
                            const targetIndex = next.indexOf(targetId)
                            next.splice(before ? targetIndex : targetIndex + 1, 0, dragId)
                            if (next.join(',') !== ids.join(',')) {
                              void useChatListStore.getState().reorderSessions(activeProject?.id || p.id, next)
                            }
                          }}
                          onDragEnd={() => { setDragSessionId(null); setDropSessionId(null) }}
                          title={isMultiSelect ? t('chatSession.multiSelectHint') : t('layout.dragToReorder')}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '3px 8px', borderRadius: 6,
                            cursor: 'pointer', fontSize: 'calc(12.8px * var(--font-scale))',
                            color: isSelected
                              ? 'var(--accent)'
                              : location.pathname === '/chat' && activeSessionId === session.id ? 'var(--accent)' : 'var(--meta)',
                            background: isDropTarget
                              ? 'var(--accent-light)'
                              : isSelected ? 'var(--accent-light)'
                              : location.pathname === '/chat' && activeSessionId === session.id ? 'var(--accent-light)' : 'transparent',
                            opacity: isDragSource ? 0.4 : 1,
                            outline: isDropTarget || isSelected ? '1px solid var(--accent)' : 'none',
                            overflow: 'hidden',
                          }}
                        >
                          {/* Checkbox indicator (always shown in multi-select mode) */}
                          {isMultiSelect && (
                            <span
                              style={{
                                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                                border: isSelected ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                                background: isSelected ? 'var(--accent)' : 'transparent',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                              }}
                            >
                              {isSelected && <Icon name="check" size={9} strokeWidth={3} style={{ color: 'var(--bg)' }} />}
                            </span>
                          )}
                          <Icon name="bot" size={11.6} strokeWidth={2} style={{ flexShrink: 0 }} />
                          {renameSessionId === session.id ? (
                            <Input
                              ref={renameSessionInputRef}
                              value={renameSessionValue}
                              onChange={(e) => setRenameSessionValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { void handleRenameSession(session.id, renameSessionValue) }
                                if (e.key === 'Escape') setRenameSessionId(null)
                              }}
                              onBlur={() => { if (renameSessionId === session.id) void handleRenameSession(session.id, renameSessionValue) }}
                              onClick={(e) => e.stopPropagation()}
                              style={{ flex: 1, height: 25, fontSize: 'calc(12.8px * var(--font-scale))', padding: '0 4px', border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)', minWidth: 0 }}
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
                          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, height: 24 }}>
                            {hoveredSessionId === session.id || !(session.updated_at || session.created_at) ? (
                              <Button
                                variant="icon"
                                className="ws-more-btn"
                                onClick={(e) => openSessionMenu(e, session.id, session.title)}
                                title={t('layout.moreActions')}
                                aria-label={t('layout.moreActions')}
                                style={{ width: 24, height: 24, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: '22px', padding: 0, flexShrink: 0 }}
                              >⋯</Button>
                            ) : (
                              <time
                                dateTime={session.updated_at || session.created_at}
                                title={formatConversationDateTime(session.updated_at || session.created_at, Date.now(), locale)}
                                style={{
                                  flexShrink: 0, whiteSpace: 'nowrap', padding: '0 6px',
                                  display: 'inline-flex', alignItems: 'center', height: '100%',
                                  fontSize: 'calc(10.5px * var(--font-scale))', color: 'var(--meta)', opacity: 0.8,
                                }}
                              >
                                {formatRelativeTime(session.updated_at || session.created_at, sidebarNow, t)}
                              </time>
                            )}
                          </div>
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
          ))}
          {projects.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', fontStyle: 'italic' }}>
              {t('nav.noProjects')}
            </div>
          )}
        </div>

        {onboardingStatus !== 'completed' && (
          <Button
            variant="ghost"
            onClick={() => useOnboardingStore.getState().reopen()}
            style={{
              margin: '0 12px 4px', width: 'calc(100% - 24px)', height: 34,
              padding: '0 10px', justifyContent: 'flex-start', gap: 9,
              borderRadius: 9, fontSize: 'calc(13px * var(--font-scale))', color: 'var(--fg-2)',
            }}
          >
            <Icon name="sparkles" size={16} strokeWidth={2} />
            {t('onboarding.reopen')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => { setSettingsSection('providers'); setSettingsFocus(undefined); setShowSettings(true) }}
          aria-current={showSettings ? 'page' : undefined}
          style={{
            margin: '0 12px 12px', width: 'calc(100% - 24px)', height: 36,
            padding: '0 10px', justifyContent: 'flex-start', gap: 9,
            borderRadius: 9, fontSize: 'calc(13px * var(--font-scale))',
            color: showSettings ? 'var(--fg)' : 'var(--fg-2)',
            background: showSettings ? 'var(--surface)' : 'transparent',
          }}
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

      {projectContextMenu && (
        <div
          ref={projectMenuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: projectContextMenu.x, top: projectContextMenu.y,
            minWidth: 140, padding: '4px 0', zIndex: 500,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)',
          }}
        >
          {projectContextMenu.project.type !== 'remote' && (
            <div
              onClick={() => {
                setRenameId(projectContextMenu.project.path)
                setRenameName(projectContextMenu.project.name)
                setRenameError('')
                setProjectContextMenu(null)
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
            >
              <Icon name="pencil" size={14} />
              {t('common.rename')}
            </div>
          )}
          {projectContextMenu.project.type !== 'remote' && (
            <div
              onClick={() => {
                setShareProject(projectContextMenu.project)
                setProjectContextMenu(null)
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
            >
              <Icon name="share" size={14} />
              {t('layout.remoteShareTitle')}
            </div>
          )}
          <div
            onClick={() => {
              setDeleteProjectError('')
              setDeleteProjectTarget(projectContextMenu.project)
              setProjectContextMenu(null)
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', color: 'var(--danger)' }}
          >
            <Icon name="trash" size={14} />
            {t('layout.deleteProjectTitle')}
          </div>
        </div>
      )}

      {moreMenu && (
        <div
          ref={moreMenuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: moreMenu.x, top: moreMenu.y,
            minWidth: 148, padding: '4px 0', zIndex: 500,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)',
          }}
        >
          {moreMenu.kind === 'project' && menuTarget && 'path' in menuTarget && (
            <>
              {menuTarget.type !== 'remote' && (
                <div
                  onClick={() => { setRenameId(menuTarget.path); setRenameName(menuTarget.name); setRenameError(''); setMoreMenu(null) }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
                >
                  <Icon name="pencil" size={14} />
                  {t('common.rename')}
                </div>
              )}
              <div
                onClick={() => { openAddWorkflow(menuTarget.id); setMoreMenu(null) }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
              >
                <Icon name="plus" size={14} />
                {t('layout.addWorkflowTitle')}
              </div>
              <div
                onClick={() => {
                  setMoreMenu(null)
                  void handleCreateSession(menuTarget)
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
              >
                <Icon name="bot" size={14} />
                {t('chatSession.addSessionTitle')}
              </div>
              {menuTarget.type !== 'remote' && (
                <div
                  onClick={() => { setShareProject(menuTarget); setMoreMenu(null) }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
                >
                  <Icon name="share" size={14} />
                  {t('layout.remoteShareTitle')}
                </div>
              )}
              <div
                onClick={() => { setDeleteProjectError(''); setDeleteProjectTarget(menuTarget); setMoreMenu(null) }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', color: 'var(--danger)' }}
              >
                <Icon name="trash" size={14} />
                {t('layout.deleteProjectTitle')}
              </div>
            </>
          )}
          {moreMenu.kind === 'workflow' && menuTarget && 'workflow' in menuTarget && (
            menuTarget.workflow.deleted ? (
              <>
                <div
                  onClick={() => { restoreWorkflow(menuTarget.workflow.id, menuTarget.project.id); setMoreMenu(null) }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
                >
                  <Icon name="rotate-ccw" size={14} />
                  {t('layout.restoreFlow')}
                </div>
                {!menuTarget.workflow.is_default && (
                  <div
                    onClick={() => { setDeleteWf({ id: menuTarget.workflow.id, projectId: menuTarget.project.id, name: menuTarget.workflow.name, soft: true }); setMoreMenu(null) }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', color: 'var(--danger)' }}
                  >
                    <Icon name="trash" size={14} />
                    {t('nav.deletePermanent')}
                  </div>
                )}
              </>
            ) : (
              <>
                <div
                  onClick={() => { setRenameWfId(menuTarget.workflow.id); setRenameWfName(menuTarget.workflow.name); setMoreMenu(null) }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
                >
                  <Icon name="pencil" size={14} />
                  {t('common.rename')}
                </div>
                {!menuTarget.workflow.is_default && menuTarget.project.workflows.filter((w) => !w.deleted).length > 1 && (
                  <div
                    onClick={() => { setDeleteWf({ id: menuTarget.workflow.id, projectId: menuTarget.project.id, name: menuTarget.workflow.name, soft: false }); setMoreMenu(null) }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', color: 'var(--danger)' }}
                  >
                    <Icon name="trash" size={14} />
                    {t('common.delete')}
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      {sessionMenu && (
        <div
          ref={sessionMenuRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', left: sessionMenu.x, top: sessionMenu.y,
            minWidth: 148, padding: '4px 0', zIndex: 500,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-raised)',
          }}
        >
          <div
            onClick={() => {
              setRenameSessionId(sessionMenu.sessionId)
              setRenameSessionValue(sessionMenu.title)
              setSessionMenu(null)
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer' }}
          >
            <Icon name="pencil" size={14} />
            {t('common.rename')}
          </div>
          <div
            onClick={() => {
              setSessionDeleteError('')
              setDeleteSessionTarget(sessionMenu)
              setSessionMenu(null)
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13px * var(--font-scale))', cursor: 'pointer', color: 'var(--danger)' }}
          >
            <Icon name="trash" size={14} />
            {t('common.delete')}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteSessionTarget !== null}
        title={t('chatSession.deleteTitle')}
        message={deleteSessionTarget ? t('chatSession.deleteMessage', { title: deleteSessionTarget.title }) : ''}
        confirmText={t('chatSession.deleteConfirm')}
        danger
        onConfirm={() => void handleDeleteSession()}
        onCancel={() => setDeleteSessionTarget(null)}
      />
      {sessionDeleteError && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 2200,
          padding: '8px 14px', borderRadius: 8, fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)',
          background: 'var(--bg)', border: '1px solid var(--danger)', boxShadow: 'var(--elev-raised)',
        }}>
          {sessionDeleteError}
        </div>
      )}

      {/* Main content */}
      <main className="app-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {children}
      </main>

      {showSettings && (
        <SettingsPage
          initialSection={settingsSection}
          focusTarget={settingsFocus}
          preferredProviderId={useOnboardingStore.getState().providerId}
          onConfigurationChanged={() => setOnboardingRefreshToken((value) => value + 1)}
          onClose={() => {
            setShowSettings(false)
            setSettingsFocus(undefined)
            setOnboardingRefreshToken((value) => value + 1)
          }}
        />
      )}

      <OnboardingChecklist
        refreshToken={onboardingRefreshToken}
        creatingWorkflow={onboardingWorkflowBusy}
        error={onboardingError}
        onOpenProvider={() => {
          useOnboardingStore.getState().chooseSetupMode('provider')
          openOnboardingSettings('providers', 'provider-create')
        }}
        onOpenLocalAgent={() => {
          useOnboardingStore.getState().chooseSetupMode('local')
          openOnboardingSettings('engines', 'execution-engine')
        }}
        onOpenEngine={() => openOnboardingSettings('engines', 'execution-engine')}
        onOpenProject={openOnboardingProject}
        onCreateWorkflow={() => void createOnboardingWorkflow()}
        onCreateTask={openOnboardingTask}
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
          <div style={{ padding: '8px 0', fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)' }}>
            {bulkDeleteError}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
