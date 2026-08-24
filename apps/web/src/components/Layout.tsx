import Icon from './Icon'
import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import { useTaskStore } from '../stores/taskStore'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useWebSocket } from '../hooks/useWebSocket'
import Button from './Button'
import DirectoryBrowser from './DirectoryBrowser'
import Field from './Field'
import Input from './Input'
import SettingsPage from '../pages/SettingsPage'
import Select from './Select'
import ConfirmDialog from './ConfirmDialog'
import ProjectShareDialog from './ProjectShareDialog'
import AiFlowChat from './AiFlowChat'
import type { GenProposalCard } from '../stores/workflowGenStore'
import { assistantStarterPrompt, backfillEmptyTitle } from '../utils/assistantTitle'
import FlowCanvas, { type FlowCanvasHandle } from './FlowCanvas'
import {
  fetchTemplates,
  templateApi,
  chatSessionApi,
  type TemplateInfo,
  type Project,
} from '../api/client'

const sidebarStyle: React.CSSProperties = {
  width: 280, minWidth: 280,
  background: 'var(--bg)',
  borderRight: '1px solid var(--border-soft)',
  display: 'flex', flexDirection: 'column',
  overflow: 'hidden',
}

const sectionLabel: React.CSSProperties = {
  padding: '14px 14px 6px',
  fontSize: 11, fontWeight: 600,
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  display: 'flex', alignItems: 'center',
  justifyContent: 'space-between',
}

const nestedSectionLabel: React.CSSProperties = {
  margin: '10px 12px 2px 28px',
  fontSize: 14, fontWeight: 600,
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
  cursor: 'pointer', fontSize: 14,
  color: active ? 'var(--fg)' : 'var(--fg-2)',
  background: active ? 'var(--surface)' : 'transparent',
  fontWeight: active ? 500 : 400,
  marginBottom: 2,
  transition: 'all var(--motion-fast)',
})

const addButtonStyle: React.CSSProperties = {
  margin: '8px 12px 8px',
  padding: 8,
  border: '1.5px dashed var(--border)',
  borderRadius: 'var(--radius-sm)',
  textAlign: 'center' as const,
  cursor: 'pointer', color: 'var(--meta)',
  fontSize: 13, background: 'transparent',
  width: 'calc(100% - 24px)',
  fontFamily: 'var(--font-body)',
}

const hasWhitespace = (s: string) => /\s/.test(s)

interface Props {
  onSelectProject: (p: Project) => void
  children: React.ReactNode
}

export default function Layout({ onSelectProject, children }: Props) {
  const { t } = useI18n()
  useWebSocket()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { projects, activeProject, activeWorkflowId, fetchProjects, initProject, addRemoteProject, setActiveProject, renameProject, deleteProject, renameWorkflow, createWorkflow, deleteWorkflow, restoreWorkflow, reorderProjects, reorderWorkflows, setActiveWorkflow } = useProjectStore()
  const [showInitModal, setShowInitModal] = useState(false)
  const [addProjectMode, setAddProjectMode] = useState<'local' | 'remote'>('local')
  const [remoteShareString, setRemoteShareString] = useState('')
  const [addingRemote, setAddingRemote] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [addWfProjectId, setAddWfProjectId] = useState<string | null>(null)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [addWfTemplateId, setAddWfTemplateId] = useState('')
  const [addWfSteps, setAddWfSteps] = useState<any>(null)
  const [addWfPreviewDirty, setAddWfPreviewDirty] = useState(false)
  const [addWfGenBusy, setAddWfGenBusy] = useState(false)
  const [addWfCreating, setAddWfCreating] = useState(false)
  const [addWfError, setAddWfError] = useState('')
  const [addWfNameAttempted, setAddWfNameAttempted] = useState(false)
  const [addWfConfirmClose, setAddWfConfirmClose] = useState(false)
  const [pendingAiSteps, setPendingAiSteps] = useState<any>(null)
  const [addWfSize, setAddWfSize] = useState<{ width: number; height: number } | null>(null)
  const [addWfChatWidth, setAddWfChatWidth] = useState<number | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(280)
  const [addWfAiOpen, setAddWfAiOpen] = useState(false)
  const [addWfAiMessage, setAddWfAiMessage] = useState('')
  const [renameWfId, setRenameWfId] = useState<string | null>(null)
  const [renameWfName, setRenameWfName] = useState('')
  const [newWfName, setNewWfName] = useState('')
  const [deleteWf, setDeleteWf] = useState<{ id: string; projectId: string; name: string; soft: boolean } | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [deleteProjectError, setDeleteProjectError] = useState('')
  const [shareProject, setShareProject] = useState<Project | null>(null)
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ kind: 'project' | 'workflow'; id: string; x: number; y: number } | null>(null)
  const [dragProjectId, setDragProjectId] = useState<string | null>(null)
  const [dropProjectId, setDropProjectId] = useState<string | null>(null)
  const sessions = useChatListStore((s) => s.sessions)
  const runningChatSessions = useChatSessionStore(
    useShallow((s) =>
      Object.fromEntries(
        Object.entries(s.sessions).map(([id, session]) => [id, session.running]),
      ),
    ),
  )
  const activeSessionId = location.pathname === '/chat' ? searchParams.get('session') : null
  const [dragWfId, setDragWfId] = useState<string | null>(null)
  const [dropWfId, setDropWfId] = useState<string | null>(null)
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dropSessionId, setDropSessionId] = useState<string | null>(null)
  const [pendingWfSwitch, setPendingWfSwitch] = useState<{ project: Project; workflowId: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const wfInputRef = useRef<HTMLInputElement>(null)
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
  const [sessionSectionOpen, setSessionSectionOpen] = useState<Record<string, boolean>>({})
  const [flowSectionOpen, setFlowSectionOpen] = useState<Record<string, boolean>>({})
  const [creatingSession, setCreatingSession] = useState(false)
  const previewCanvasRef = useRef<FlowCanvasHandle>(null)
  const addWfModalRef = useRef<HTMLDivElement>(null)

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
    document.body.style.userSelect = 'none'
  }

  const startDividerDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const modalWidth = addWfModalRef.current?.clientWidth ?? window.innerWidth * 0.9
    const startWidth = addWfChatWidth ?? Math.round((modalWidth * 2) / 5)
    const onMove = (ev: MouseEvent) => {
      setAddWfChatWidth(Math.min(Math.round(modalWidth * 0.6), Math.max(280, startWidth - (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }

  const startModalResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const rect = addWfModalRef.current?.getBoundingClientRect()
    const startWidth = rect?.width ?? window.innerWidth * 0.9
    const startHeight = rect?.height ?? 780
    const onMove = (ev: MouseEvent) => {
      const width = Math.min(window.innerWidth - 24, Math.max(760, startWidth + (ev.clientX - startX)))
      const height = Math.min(window.innerHeight - 24, Math.max(480, startHeight + (ev.clientY - startY)))
      setAddWfSize({ width, height })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'nwse-resize'
  }

  useEffect(() => { fetchProjects() }, [fetchProjects])

  useEffect(() => {
    if (!projects.some((project) => project.type === 'remote')) return
    const timer = window.setInterval(() => { void fetchProjects() }, 3000)
    return () => window.clearInterval(timer)
  }, [projects, fetchProjects])

  // Re-focus inputs each time they open (autoFocus only fires on first mount)
  useEffect(() => {
    if (renameId) {
      const t = setTimeout(() => renameInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [renameId])

  useEffect(() => {
    if (addWfProjectId) {
      const t = setTimeout(() => wfInputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [addWfProjectId])

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

  // Refresh flow running states whenever a task status event arrives
  const taskStatusEvents = useTaskStore((s) => s.taskStatusEvents)
  useEffect(() => {
    if (!taskStatusEvents) return
    const t = setTimeout(() => { fetchProjects() }, 300)
    return () => clearTimeout(t)
  }, [taskStatusEvents, fetchProjects])

  // Load the active project's chat sessions into the sidebar.
  useEffect(() => {
    if (!activeProject?.id) return
    void useChatListStore.getState().fetchSessions(activeProject.id)
  }, [activeProject?.id])

  // Auto-select project from URL ?project=name (only once)
  const projectName = searchParams.get('project')
  useEffect(() => {
    if (projectName && projects.length > 0 && (!activeProject || activeProject.name !== projectName)) {
      const match = projects.find((p) => p.name === projectName)
      if (match) {
        setActiveProject(match)
      }
    }
  }, [projectName, projects, activeProject, setActiveProject])

  const handleSelectProject = (p: Project) => {
    setActiveProject(p)
    onSelectProject(p)
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

  const openAddWorkflow = async (projectId: string) => {
    setAddWfProjectId(projectId)
    setNewWfName('')
    setAddWfTemplateId('')
    setAddWfSteps(null)
    setAddWfPreviewDirty(false)
    setAddWfGenBusy(false)
    setAddWfError('')
    setAddWfNameAttempted(false)
    setAddWfConfirmClose(false)
    setPendingAiSteps(null)
    setAddWfSize(null)
    setAddWfChatWidth(null)
    setAddWfAiOpen(false)
    setAddWfAiMessage('')
    try {
      const { templates: list } = await fetchTemplates()
      setTemplates(list)
    } catch {
      setTemplates([])
    }
  }

  const closeAddWorkflow = () => {
    setAddWfProjectId(null)
    setNewWfName('')
    setAddWfTemplateId('')
    setAddWfSteps(null)
    setAddWfPreviewDirty(false)
    setAddWfGenBusy(false)
    setAddWfError('')
    setAddWfNameAttempted(false)
    setAddWfConfirmClose(false)
    setPendingAiSteps(null)
    setAddWfSize(null)
    setAddWfChatWidth(null)
    setAddWfAiOpen(false)
    setAddWfAiMessage('')
  }

  const requestCloseAddWorkflow = () => {
    if (addWfPreviewDirty || addWfGenBusy) {
      setAddWfConfirmClose(true)
      return
    }
    closeAddWorkflow()
  }

  const handleAiProposal = (steps: any, proposal?: GenProposalCard) => {
    setNewWfName((current) => backfillEmptyTitle(current, proposal?.workflowName))
    // A new proposal replaces the preview; guard manual edits with a confirm.
    if (addWfPreviewDirty) {
      setPendingAiSteps(steps)
      return
    }
    setAddWfSteps(steps)
  }

  const handleTemplateChange = async (templateId: string) => {
    setAddWfTemplateId(templateId)
    setAddWfError('')
    if (!templateId) {
      setAddWfSteps(null)
      return
    }
    try {
      const full = await templateApi.get(templateId)
      setAddWfSteps(full.steps || { nodes: [], connections: [] })
    } catch (reason) {
      setAddWfError(reason instanceof Error ? reason.message : t('layout.loadTemplateFailed'))
    }
  }

  const requestCloseAddWfAi = () => {
    if (addWfGenBusy) {
      setAddWfConfirmClose(true)
      return
    }
    setAddWfAiOpen(false)
  }

  const handleStartAiCreate = () => {
    if (addWfAiOpen) {
      requestCloseAddWfAi()
      return
    }
    if (!addWfProjectId) return
    setAddWfNameAttempted(false)
    setAddWfAiMessage(assistantStarterPrompt(
      newWfName,
      (name) => t('layout.aiCreatePrompt', { name }),
    ))
    setAddWfAiOpen(true)
  }

  const handleAddWorkflow = async () => {
    if (!addWfProjectId || addWfGenBusy) return
    if (!newWfName.trim()) {
      setAddWfNameAttempted(true)
      wfInputRef.current?.focus()
      return
    }
    if (hasWhitespace(newWfName)) {
      setAddWfNameAttempted(true)
      wfInputRef.current?.focus()
      return
    }
    const validationError = previewCanvasRef.current?.validate() ?? null
    if (validationError) {
      setAddWfError(validationError)
      return
    }
    const steps = previewCanvasRef.current?.getSteps() ?? addWfSteps ?? undefined
    setAddWfCreating(true)
    setAddWfError('')
    try {
      await createWorkflow(addWfProjectId, newWfName.trim(), addWfTemplateId || undefined, steps)
      closeAddWorkflow()
    } catch (reason) {
      setAddWfError(reason instanceof Error ? reason.message : t('layout.createWorkflowFailed'))
    } finally {
      setAddWfCreating(false)
    }
  }

  const handleInit = async () => {
    if (!newPath.trim()) return
    if (hasWhitespace(newName)) {
      setError(t('layout.nameWhitespace'))
      return
    }
    try {
      setError('')
      const proj = await initProject(newPath.trim(), newName.trim() || undefined)
      setActiveProject(proj)
      onSelectProject(proj)
      setShowInitModal(false)
      setNewPath('')
      setNewName('')
      setShowBrowser(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleAddRemote = async () => {
    if (!remoteShareString.trim() || addingRemote) return
    setAddingRemote(true)
    setError('')
    try {
      const project = await addRemoteProject(remoteShareString)
      setActiveProject(project)
      onSelectProject(project)
      setShowInitModal(false)
      setRemoteShareString('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('layout.remoteAddFailed'))
    } finally {
      setAddingRemote(false)
    }
  }

  const handleDirSelect = (path: string) => {
    setNewPath(path)
    setShowBrowser(false)
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
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* Sidebar */}
      <aside style={{ ...sidebarStyle, width: sidebarWidth, minWidth: 180 }}>
        <div style={{ padding: '12px 14px 8px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-display)' }}>
            <Icon name="layers" size={18} strokeWidth={2} color="var(--accent)" />
            WorkStep
            <a
              href="/landing"
              style={{
                marginLeft: 'auto',
                padding: '2px 8px',
                fontSize: 11,
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
            borderRadius: 9, fontSize: 13,
            color: location.pathname === '/statistics' ? 'var(--fg)' : 'var(--fg-2)',
            background: location.pathname === '/statistics' ? 'var(--surface)' : 'transparent',
          }}
        >
          <Icon name="bar-chart" size={17} strokeWidth={2} />
          {t('nav.statistics')}
        </Button>

        <div style={sectionLabel}>{t('layout.projects')}</div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
          {projects.map((p) => (
            <div key={p.id}>
              <div
                onClick={() => handleSelectProject(p)}
                onDoubleClick={(e) => {
                  if (p.type === 'remote') return
                  e.stopPropagation(); setRenameId(p.path); setRenameName(p.name); setRenameError('')
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
                  userSelect: 'none',
                  opacity: dragProjectId === p.id ? 0.4 : 1,
                  outline: dropProjectId === p.id ? '1px solid var(--accent)' : 'none',
                  ...(dropProjectId === p.id ? { background: 'var(--accent-light)' } : {}),
                }}
              >
                <Icon
                  name={p.type === 'remote' ? 'external-link' : activeProject?.id === p.id ? 'folder-open' : 'folder'} size={16.4} strokeWidth={2}
                  style={{ flexShrink: 0, color: activeProject?.id === p.id ? 'var(--accent)' : 'var(--meta)' }}
                />
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
                    style={{ flex: 1, height: 30, fontSize: 14, padding: '0 4px', border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                  />
                ) : (
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                    {p.type === 'remote' && (
                      <span
                        title={p.endpoint}
                        style={{
                          display: 'inline-block',
                          marginLeft: 6,
                          padding: '0 4px',
                          borderRadius: 3,
                          background: 'var(--surface)',
                          color: 'var(--meta)',
                          fontSize: 10,
                          lineHeight: '16px',
                          verticalAlign: 1,
                        }}
                      >
                        {t('layout.remoteLabel')}
                      </span>
                    )}
                  </span>
                )}
                {p.workflows?.some((workflow) => workflow.running) && (
                  <span
                    className="task-status-spinner"
                    style={{ color: 'var(--accent)', flexShrink: 0 }}
                    title={t('layout.flowRunning')}
                    aria-hidden="true"
                  />
                )}
                <Button
                  variant="icon"
                  className="ws-more-btn"
                  onClick={(e) => openMoreMenu(e, 'project', p.id)}
                  title={t('layout.moreActions')}
                  aria-label={t('layout.moreActions')}
                  style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', fontSize: 13, lineHeight: '18px', padding: 0, flexShrink: 0 }}
                >⋯</Button>
              </div>

              {renameId === p.path && renameError && (
                <div style={{ marginLeft: 38, marginBottom: 4, fontSize: 11, color: 'var(--danger)' }}>{renameError}</div>
              )}

              {/* Workflow list + sessions under the selected project */}
              {activeProject?.id === p.id && (
                <>
                  {(() => {
                    const flowOpen = flowSectionOpen[p.id] !== false
                    return (
                      <>
                        <div
                          style={{ ...nestedSectionLabel, cursor: 'pointer', userSelect: 'none' }}
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
                            <Button
                              variant="icon"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); void openAddWorkflow(p.id) }}
                              title={t('layout.addWorkflowTitle')}
                              aria-label={t('layout.addWorkflowTitle')}
                              style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', padding: 0, flexShrink: 0 }}
                            >
                              <Icon name="plus" size={9.6} strokeWidth={2} />
                            </Button>
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
                        const dirty = useProjectStore.getState().canvasDirty
                        if (location.pathname === '/canvas' && dirty) {
                          setPendingWfSwitch({ project: p, workflowId: wf.id })
                          return
                        }
                        setActiveProject(p)
                        await setActiveWorkflow(wf.id)
                        navigate('/tasks')
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
                        fontSize: 14,
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
                          style={{ flex: 1, height: 28, fontSize: 14, padding: '0 4px', border: `1px solid ${hasWhitespace(renameWfName) ? 'var(--danger)' : 'var(--accent)'}`, borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)' }}
                        />
                      ) : (
                        <span
                          style={{ flex: 1, textDecoration: deleted ? 'line-through' : 'none', opacity: deleted ? 0.6 : 1, cursor: deleted ? 'default' : 'pointer' }}
                          onDoubleClick={(e) => { e.stopPropagation(); if (!deleted) { setRenameWfId(wf.id); setRenameWfName(wf.name) } }}
                        >{wf.name}</span>
                      )}
                      {wf.running && !deleted && (
                        <span className="task-status-spinner" style={{ color: 'var(--accent)', flexShrink: 0, width: 10.4, height: 10.4 }} title={t('layout.flowRunning')} aria-hidden="true" />
                      )}
                      {deleted && <span style={{ fontSize: 11.6, color: 'var(--danger)', opacity: 0.8 }}>{t('layout.trash')}</span>}
                      {wf.is_default ? <span style={{ fontSize: 11.6, opacity: 0.6 }}>{t('layout.default')}</span> : null}
                      <span style={{ fontSize: 11.6, opacity: 0.5 }}>{t('flow.nodeCount', { count: wf.nodeCount })}</span>
                      <Button
                        variant="icon"
                        className="ws-more-btn"
                        onClick={(e) => openMoreMenu(e, 'workflow', wf.id)}
                        title={t('layout.moreActions')}
                        aria-label={t('layout.moreActions')}
                        style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', fontSize: 14, lineHeight: '26px', padding: 0, flexShrink: 0 }}
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
                const open = !!sessionSectionOpen[p.id] || (location.pathname === '/chat' && !!activeSessionId)
                return (
                  <>
                    <div
                      style={{
                        ...nestedSectionLabel,
                        cursor: 'pointer', userSelect: 'none',
                        margin: '14px 12px 2px 28px',
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
                        <Button
                          variant="icon"
                          size="sm"
                          loading={creatingSession}
                          disabled={creatingSession}
                          onClick={(e) => { e.stopPropagation(); void handleCreateSession(p) }}
                          title={t('chatSession.newSession')}
                          aria-label={t('chatSession.newSession')}
                          style={{ width: 20, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', padding: 0, flexShrink: 0 }}
                        >
                          <Icon name="plus" size={9.6} strokeWidth={2} />
                        </Button>
                      )}
                    </div>
                    {open && (
                    <div style={{ margin: '0 12px 6px 28px', display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {sessions.map(session => {
                        const isDragSource = dragSessionId === session.id
                        const isDropTarget = dropSessionId === session.id
                        const sessionRunning = !!runningChatSessions[session.id]
                        return (
                        <div
                          key={session.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (renameSessionId === session.id) return
                            navigate(`/chat?project=${encodeURIComponent(p.name)}&session=${encodeURIComponent(session.id)}`)
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            setRenameSessionId(session.id)
                            setRenameSessionValue(session.title)
                          }}
                          onContextMenu={(e) => openSessionMenu(e, session.id, session.title)}
                          className="ws-row"
                          draggable={renameSessionId !== session.id}
                          onDragStart={(e) => {
                            e.stopPropagation()
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', session.id)
                            setDragSessionId(session.id)
                          }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (dropSessionId !== session.id) setDropSessionId(session.id)
                          }}
                          onDragLeave={(e) => {
                            e.stopPropagation()
                            if (dropSessionId === session.id) setDropSessionId(null)
                          }}
                          onDrop={(e) => {
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
                          title={t('layout.dragToReorder')}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '3px 8px', borderRadius: 6,
                            cursor: 'pointer', fontSize: 12.8,
                            color: location.pathname === '/chat' && activeSessionId === session.id ? 'var(--accent)' : 'var(--meta)',
                            background: isDropTarget
                              ? 'var(--accent-light)'
                              : location.pathname === '/chat' && activeSessionId === session.id ? 'var(--accent-light)' : 'transparent',
                            opacity: isDragSource ? 0.4 : 1,
                            outline: isDropTarget ? '1px solid var(--accent)' : 'none',
                            overflow: 'hidden',
                          }}
                        >
                          {sessionRunning ? (
                            <span
                              className="task-status-spinner"
                              style={{ color: 'var(--accent)', flexShrink: 0, width: 11.6, height: 11.6 }}
                              title={t('chatSession.runningHint')}
                              aria-hidden="true"
                            />
                          ) : (
                            <Icon name="bot" size={11.6} strokeWidth={2} style={{ flexShrink: 0 }} />
                          )}
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
                              style={{ flex: 1, height: 25, fontSize: 12.8, padding: '0 4px', border: '1px solid var(--accent)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--fg)', minWidth: 0 }}
                            />
                          ) : (
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.title}</span>
                          )}
                          <Button
                            variant="icon"
                            className="ws-more-btn"
                            onClick={(e) => openSessionMenu(e, session.id, session.title)}
                            title={t('layout.moreActions')}
                            aria-label={t('layout.moreActions')}
                            style={{ width: 28, height: 28, borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--meta)', fontSize: 14, lineHeight: '26px', padding: 0, flexShrink: 0 }}
                          >⋯</Button>
                        </div>
                        )
                      })}
                    </div>
                    )}
                  </>
                )
              })()}
              </>
              )}
            </div>
          ))}
          {projects.length === 0 && (
            <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--meta)', fontStyle: 'italic' }}>
              {t('nav.noProjects')}
            </div>
          )}
        </div>

        <Button variant="ghost" style={addButtonStyle} onClick={() => { setAddProjectMode('local'); setError(''); setShowInitModal(true) }}>
          + {t('nav.addProject')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowSettings(true)}
          aria-current={showSettings ? 'page' : undefined}
          style={{
            margin: '0 12px 12px', width: 'calc(100% - 24px)', height: 36,
            padding: '0 10px', justifyContent: 'flex-start', gap: 9,
            borderRadius: 9, fontSize: 13,
            color: showSettings ? 'var(--fg)' : 'var(--fg-2)',
            background: showSettings ? 'var(--surface)' : 'transparent',
          }}
        >
          <Icon name="settings" size={17} strokeWidth={2} />
          {t('nav.settings')}
        </Button>
      </aside>

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
                setShareProject(projectContextMenu.project)
                setProjectContextMenu(null)
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
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
            style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
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
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                >
                  <Icon name="pencil" size={14} />
                  {t('common.edit')}
                </div>
              )}
              <div
                onClick={() => { openAddWorkflow(menuTarget.id); setMoreMenu(null) }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
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
                style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
              >
                <Icon name="bot" size={14} />
                {t('chatSession.addSessionTitle')}
              </div>
              {menuTarget.type !== 'remote' && (
                <div
                  onClick={() => { setShareProject(menuTarget); setMoreMenu(null) }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                >
                  <Icon name="share" size={14} />
                  {t('layout.remoteShareTitle')}
                </div>
              )}
              <div
                onClick={() => { setDeleteProjectError(''); setDeleteProjectTarget(menuTarget); setMoreMenu(null) }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
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
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                >
                  <Icon name="rotate-ccw" size={14} />
                  {t('layout.restoreFlow')}
                </div>
                {!menuTarget.workflow.is_default && (
                  <div
                    onClick={() => { setDeleteWf({ id: menuTarget.workflow.id, projectId: menuTarget.project.id, name: menuTarget.workflow.name, soft: true }); setMoreMenu(null) }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
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
                  style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                >
                  <Icon name="pencil" size={14} />
                  {t('common.edit')}
                </div>
                {!menuTarget.workflow.is_default && menuTarget.project.workflows.filter((w) => !w.deleted).length > 1 && (
                  <div
                    onClick={() => { setDeleteWf({ id: menuTarget.workflow.id, projectId: menuTarget.project.id, name: menuTarget.workflow.name, soft: false }); setMoreMenu(null) }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
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
            style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
          >
            <Icon name="pencil" size={14} />
            {t('common.edit')}
          </div>
          <div
            onClick={() => {
              setSessionDeleteError('')
              setDeleteSessionTarget(sessionMenu)
              setSessionMenu(null)
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            style={{ padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: 'var(--danger)' }}
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
          padding: '8px 14px', borderRadius: 8, fontSize: 13, color: 'var(--danger)',
          background: 'var(--bg)', border: '1px solid var(--danger)', boxShadow: 'var(--elev-raised)',
        }}>
          {sessionDeleteError}
        </div>
      )}

      {/* Main content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {children}
      </main>

      {showSettings && <SettingsPage onClose={() => setShowSettings(false)} />}

      {/* Init project modal */}
      {showInitModal && (
        <div className="modal-overlay" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>
          <div className="modal" style={{ width: showBrowser ? 600 : 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{t('layout.initTitle')}</span>
              <Button variant="icon" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>✕</Button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                <Button variant={addProjectMode === 'local' ? 'primary' : 'ghost'} onClick={() => { setAddProjectMode('local'); setError('') }}>
                  {t('layout.localProject')}
                </Button>
                <Button variant={addProjectMode === 'remote' ? 'primary' : 'ghost'} onClick={() => { setAddProjectMode('remote'); setError(''); setShowBrowser(false) }}>
                  {t('layout.remoteProject')}
                </Button>
              </div>
              {addProjectMode === 'local' ? <>
              <Field label={t('layout.projectPath')} htmlFor="init-path">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Input
                    id="init-path"
                    style={{ flex: 1 }}
                    placeholder="/Users/me/my-app"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                  />
                  <Button variant="ghost" onClick={() => setShowBrowser(!showBrowser)}>
                    {showBrowser ? t('layout.collapse') : t('layout.browse')}
                  </Button>
                </div>
              </Field>

              {showBrowser && (
                <div style={{ marginTop: 8 }}>
                  <DirectoryBrowser onSelect={handleDirSelect} />
                </div>
              )}

              <Field label={t('layout.projectNameOptional')} htmlFor="init-name" error={error}>
                <Input
                  id="init-name"
                  placeholder={t('layout.defaultDirName')}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleInit()}
                />
              </Field>
              </> : (
                <Field label={t('layout.remoteShareString')} htmlFor="remote-share-string" error={error}>
                  <textarea
                    id="remote-share-string"
                    value={remoteShareString}
                    onChange={(event) => { setRemoteShareString(event.target.value); setError('') }}
                    placeholder="workstep://remote-project/v1/..."
                    rows={6}
                    autoFocus
                    style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  />
                  <div style={{ marginTop: 7, color: 'var(--muted)', fontSize: 11 }}>{t('layout.remoteShareHint')}</div>
                </Field>
              )}
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={() => { setShowInitModal(false); setShowBrowser(false) }}>{t('common.cancel')}</Button>
              {addProjectMode === 'local' ? (
                <Button variant="primary" disabled={!newPath.trim()} onClick={handleInit}>{t('layout.init')}</Button>
              ) : (
                <Button variant="primary" loading={addingRemote} disabled={!remoteShareString.trim()} onClick={() => void handleAddRemote()}>{t('layout.connectRemote')}</Button>
              )}
            </div>
          </div>
        </div>
      )}

      <ProjectShareDialog project={shareProject} onClose={() => setShareProject(null)} />

      {/* Add workflow modal */}
      {addWfProjectId && (
        <div className="modal-overlay" style={{ zIndex: 350 }}>
          <div
            ref={addWfModalRef}
            className="modal"
            style={{
              width: addWfSize ? addWfSize.width : '90vw', maxWidth: '96vw',
              height: addWfSize ? addWfSize.height : 'min(92vh, 900px)', maxHeight: '92vh',
              display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden',
              position: 'relative',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">{t('layout.addFlowTitle')}</span>
              <Button variant="icon" aria-label={t('common.close')} onClick={requestCloseAddWorkflow}>✕</Button>
            </div>
            {/* Top form: workflow name + template */}
            <div style={{
              flexShrink: 0, padding: '12px 18px', background: 'var(--bg)',
              borderBottom: '1px solid var(--border-soft)',
              display: 'flex', gap: 14, alignItems: 'flex-start',
            }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <Field
                  label={t('layout.flowName')}
                  required
                  htmlFor="wf-name"
                  error={hasWhitespace(newWfName)
                    ? t('layout.nameWhitespace')
                    : addWfNameAttempted && !newWfName.trim()
                      ? t('layout.flowNameRequired')
                      : undefined}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input
                      id="wf-name"
                      ref={wfInputRef}
                      value={newWfName}
                      onChange={(e) => setNewWfName(e.target.value)}
                      placeholder={t('layout.flowNamePlaceholder')}
                      autoFocus
                      style={{
                        flex: 1, minWidth: 0,
                        border: `1px solid ${(hasWhitespace(newWfName) || (addWfNameAttempted && !newWfName.trim())) ? 'var(--danger)' : 'var(--border)'}`,
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleStartAiCreate}
                      aria-expanded={addWfAiOpen}
                      title={t('layout.aiCreateTitle')}
                      style={{
                        flexShrink: 0, whiteSpace: 'nowrap',
                        color: 'var(--accent)',
                        border: '1px solid color-mix(in oklab, var(--accent), transparent 55%)',
                        background: 'color-mix(in oklab, var(--accent), transparent 93%)',
                      }}
                    >
                      <Icon name="sparkles" size={13} style={{ marginRight: 4, verticalAlign: -2 }} />
                      {t('layout.aiCreate')}
                    </Button>
                  </div>
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 220 }}>
                <Field label={t('layout.flowTemplate')} htmlFor="wf-template">
                  <Select
                    id="wf-template"
                    value={addWfTemplateId}
                    onChange={(e) => void handleTemplateChange(e.target.value)}
                    style={{ width: '100%' }}
                  >
                  <option value="">{t('layout.blankFlow')}</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}（{t('flow.nodeCount', { count: template.nodeCount })}）</option>
                  ))}
                  </Select>
                </Field>
                {(() => {
                  const selected = templates.find((t) => t.id === addWfTemplateId)
                  return selected?.description ? (
                    <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.description}</p>
                  ) : null
                })()}
              </div>
            </div>
            {addWfError && (
              <div style={{
                flexShrink: 0, padding: '5px 18px', fontSize: 13, color: 'var(--danger)',
                background: 'color-mix(in oklab, var(--danger), transparent 94%)',
                borderBottom: '1px solid var(--border-soft)',
              }}>{addWfError}</div>
            )}
            <div className="modal-body" style={{ padding: 0, display: 'flex', minHeight: 0, flex: 1, overflow: 'hidden' }}>
              {/* Left: live editable canvas preview */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <FlowCanvas
                  ref={previewCanvasRef}
                  initialSteps={addWfSteps}
                  projectId={addWfProjectId}
                  onDirtyChange={setAddWfPreviewDirty}
                  onSave={async (steps) => { setAddWfSteps(steps); setAddWfPreviewDirty(false) }}
                  showTemplatePicker={false}
                  title={t('layout.previewTitle')}
                  saveLabel={t('layout.updatePreview')}
                  hint={null}
                />
              </div>
              {addWfAiOpen && (
                <>
                  {/* Draggable divider to resize the chat column */}
                  <div
                    onMouseDown={startDividerDrag}
                    title={t('layout.dragResizeChat')}
                    style={{
                      width: 8, flexShrink: 0, cursor: 'col-resize', position: 'relative',
                      background: 'transparent', userSelect: 'none',
                    }}
                  >
                    <div style={{
                      position: 'absolute', top: 0, bottom: 0, left: '50%', transform: 'translateX(-50%)',
                      width: 1, background: 'var(--border-soft)',
                    }} />
                  </div>
                  {/* Right: AI flow-design chat */}
                  <div style={{
                    width: addWfChatWidth ?? '40%', flexShrink: 0,
                    display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)',
                  }}>
                    <AiFlowChat
                      projectId={addWfProjectId}
                      getCanvasSteps={() => previewCanvasRef.current?.getSteps()}
                      onProposal={handleAiProposal}
                      onRestore={(steps) => previewCanvasRef.current?.loadSteps(steps)}
                      onBusyChange={setAddWfGenBusy}
                      title={t('aiFlow.title')}
                      initialMessage={addWfAiMessage}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <Button variant="ghost" onClick={requestCloseAddWorkflow}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                disabled={addWfGenBusy || addWfCreating || !newWfName.trim()}
                loading={addWfCreating}
                onClick={handleAddWorkflow}
              >{t('layout.createFlow')}</Button>
            </div>
            {/* Bottom-right corner resize handle */}
            <div
              onMouseDown={startModalResize}
              title={t('layout.dragResizeModal')}
              style={{
                position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
                cursor: 'nwse-resize', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
                padding: 3, color: 'var(--meta)', userSelect: 'none', zIndex: 5,
              }}
            >
              <Icon name="resize-corner" size={11} />
            </div>
          </div>
        </div>
      )}

      {/* Add workflow: confirm close with unsaved preview / running generation */}
      <ConfirmDialog
        open={addWfConfirmClose}
        title={t('canvas.unsavedTitle')}
        message={addWfGenBusy
          ? t('layout.abandonGenerating')
          : t('layout.abandonPreview')}
        confirmText={t('layout.discardChanges')}
        danger
        onConfirm={closeAddWorkflow}
        onCancel={() => setAddWfConfirmClose(false)}
      />

      {/* Add workflow: AI proposal overwrites manual preview edits */}
      <ConfirmDialog
        open={pendingAiSteps !== null}
        title={t('layout.aiOverwritePreviewTitle')}
        message={t('layout.aiOverwritePreviewMessage')}
        confirmText={t('canvas.applyProposal')}
        danger
        onConfirm={() => {
          if (pendingAiSteps !== null) setAddWfSteps(pendingAiSteps)
          setPendingAiSteps(null)
        }}
        onCancel={() => setPendingAiSteps(null)}
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
            navigate('/tasks')
          }
          setPendingWfSwitch(null)
        }}
        onCancel={() => setPendingWfSwitch(null)}
      />
    </div>
  )
}
