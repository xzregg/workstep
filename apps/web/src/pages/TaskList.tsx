import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import ResizablePanel from '../components/ResizablePanel'
import ProjectGitButton from '../components/git/ProjectGitButton'
import Select from '../components/Select'
import { copyText } from '../utils/clipboard'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useTaskRoute } from '../hooks/useTaskRoute'
import { useManagedMode } from '../hooks/useManagedMode'
import MobileSheet from '../components/MobileSheet'
import StatusBadge from '../components/StatusBadge'
import Icon from '../components/Icon'
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTaskStore, selectWorkflowTasks } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { setDetailTaskIds } from '../hooks/useWebSocket'
import { scheduleApi } from '../api/client'
import TaskDetail from './TaskDetail'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import DeleteTaskConfirmation from '../components/DeleteTaskConfirmation'
import EmptyState from '../components/EmptyState'
import OpenLocationButton from '../components/OpenLocationButton'
import MobileOpenLocationButton from '../components/MobileOpenLocationButton'
import ProjectDirectoryBrowserDialog from '../components/ProjectDirectoryBrowserDialog'
import ProjectShareDialog from '../components/ProjectShareDialog'
import ProjectSettingsPanel from '../components/ProjectSettingsPanel'
import WorkflowHookManagerDialog from '../components/WorkflowHookManagerDialog'
import WorkflowShortcutSettingsDialog from '../components/WorkflowShortcutSettingsDialog'
import ArchiveExperienceDialog from '../components/ArchiveExperienceDialog'
import TaskCreatePanel from '../components/TaskCreatePanel'
import ProjectMemoryPanel from '../components/ProjectMemoryPanel'
import TaskTableView from '../components/TaskTableView'
import TaskBoardCard from '../components/TaskBoardCard'
import { useI18n, type TFunction } from '../i18n'
import SchedulePage from './SchedulePage'
import { deriveTaskLane, orderTaskLanes, type TaskLane } from './taskListLane'

/* ── Styles ── */
const topbarStyle: React.CSSProperties = {
  height: 48, background: 'var(--bg)',
  borderBottom: '1px solid var(--border-soft)',
  display: 'flex', alignItems: 'center',
  padding: '0 20px', gap: 12, flexShrink: 0,
}

/* ── Extract lanes from steps.json ── */
type Lane = TaskLane

/* ── Default colors for known step keys ── */
const STAGE_COLORS: Record<string, string> = {
  req: '#0071e3', ui: '#7c3aed', frontend: '#059669',
  backend: '#d97706', test: '#dc2626', deploy: '#16a34a',
}

function getLanesFromSteps(steps: any, t: TFunction): Lane[] {
  if (steps?.nodes?.length) {
    const lanes = steps.nodes.map((n: any) => {
      const key = n.type || n.key || String(n.id)
      return {
        key,
        label: n.title || n.label || n.type,
        color: n.color || STAGE_COLORS[key] || 'var(--meta)',
      }
    })
    return orderTaskLanes(lanes, steps)
  }
  if (steps?.steps?.length) {
    const lanes = steps.steps.map((s: any) => ({
      key: s.key || s.id,
      label: s.label || s.name || s.key,
      color: s.color || 'var(--meta)',
    }))
    return orderTaskLanes(lanes, steps)
  }
  return [{ key: 'do', label: t('taskList.execute'), color: 'var(--accent)' }]
}

const viewToggleButtonStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  border: 'none', cursor: disabled ? 'default' : 'pointer', display: 'grid', placeItems: 'center',
  width: 30, height: 26, borderRadius: 'var(--radius-pill)', padding: 0,
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? 'var(--accent-fg)' : 'var(--meta)',
  opacity: disabled ? 0.4 : 1,
})

export default function TaskList() {
  const managedMode = useManagedMode()
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    tasks, loading, fetchTasks, runTask, deleteTask, archiveTask,
    unarchiveTask, setActiveTask,
  } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const { bound, canEdit, canCreateTask } = useGatewayProjectPermissions(activeProject?.id)
  const renameProject = useProjectStore((s) => s.renameProject)
  const activeWorkflowId = useProjectStore((s) => s.activeWorkflowId)
  const saveSteps = useProjectStore((s) => s.saveSteps)
  const activeWorkflowName = activeProject?.workflows?.find((w) => w.id === activeWorkflowId)?.name
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [createRequest, setCreateRequest] = useState<{ stepKey?: string; id: number } | null>(null)
  const createRequestId = useRef(0)
  const openNewPanel = (stepKey?: string) => {
    if (!canCreateTask) return
    setCreateRequest({ stepKey, id: ++createRequestId.current })
  }
  const { taskId: selectedTaskId, openTask, closeTask } = useTaskRoute()
  const compact = useCompactLayout()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [showMobileDirectoryBrowser, setShowMobileDirectoryBrowser] = useState(false)
  const [mobileStep, setMobileStep] = useState('')
  useEffect(() => { setMobileStep('') }, [activeProject?.id, activeWorkflowId])
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null)
  const [deletingTask, setDeletingTask] = useState(false)
  const [confirmStartTaskId, setConfirmStartTaskId] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; title: string } | null>(null)
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  // Subscribe the daemon to this task's full event stream while its
  // detail panel is open; unsubscribe when closed or navigating away.
  useEffect(() => {
    const taskIds = [...new Set(
      [selectedTaskId, archiveTarget?.id].filter((id): id is string => Boolean(id)),
    )]
    setDetailTaskIds(taskIds)
    return () => setDetailTaskIds([])
  }, [archiveTarget?.id, selectedTaskId])
  const [scheduleCount, setScheduleCount] = useState(0)
  const [showScheduleDialog, setShowScheduleDialog] = useState(false)
  const [hooksOpen, setHooksOpen] = useState(false)
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false)
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [dragOverLane, setDragOverLane] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [copiedWorkflowId, setCopiedWorkflowId] = useState(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [directoryNotice, setDirectoryNotice] = useState('')
  // Local lane override for unstarted cards moved manually in the board.
  const [cardLanes, setCardLanes] = useState<Record<string, string>>({})
  // Board display mode: swimlanes (lane columns) or grouped table.
  const [boardView, setBoardView] = useState<'lanes' | 'table'>(() => {
    try {
      return localStorage.getItem('workstep.boardView') === 'table' ? 'table' : 'lanes'
    } catch {
      return 'lanes'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('workstep.boardView', boardView)
    } catch {
      // Storage unavailable (e.g. privacy mode) — view simply won't persist.
    }
  }, [boardView])

  useEffect(() => {
    if (activeProject?.id) fetchTasks(activeProject.id, activeWorkflowId, showArchived)
  }, [fetchTasks, activeProject?.id, activeWorkflowId, showArchived])

  useEffect(() => {
    let cancelled = false
    const projectId = activeProject?.id

    if (!projectId || bound) {
      setScheduleCount(0)
      return () => {
        cancelled = true
      }
    }

    void scheduleApi
      .list(projectId)
      .then(({ schedules }) => {
        if (!cancelled) setScheduleCount(schedules.length)
      })
      .catch(() => {
        if (!cancelled) setScheduleCount(0)
      })

    return () => {
      cancelled = true
    }
  }, [activeProject?.id, bound])

  // Reset local state when project changes
  useEffect(() => {
    setCardLanes({})
    setCreateRequest(null)
    setMemoryOpen(false)
    setShowScheduleDialog(false)
    setShortcutSettingsOpen(false)
    setHooksOpen(false)
    setShowShareDialog(false)
    setShowArchived(false)
  }, [activeProject?.path])


  const lanes = useMemo(() => getLanesFromSteps(activeProject?.steps, t), [activeProject?.steps, t])
  useEffect(() => {
    const command = searchParams.get('onboarding')
    const taskId = searchParams.get('task')
    if (command === 'create-task' && activeProject && activeWorkflowId && lanes.length > 0 && !createRequest) {
      openNewPanel()
      const next = new URLSearchParams(searchParams)
      next.delete('onboarding')
      setSearchParams(next, { replace: true })
      return
    }
    if (taskId && activeProject) {
      setActiveTask(taskId)

    }
  }, [searchParams, setSearchParams, activeProject, activeWorkflowId, lanes.length, createRequest, setActiveTask]) // eslint-disable-line react-hooks/exhaustive-deps

  // Backend step progress is the source of truth; local assignment is only a
  // temporary override before a task has started executing.
  const getCardLane = useCallback((taskId: string): string => {
    const task = tasks.find((item) => item.id === taskId)
    const hasRecordedProgress = task?.steps.some((step) => step.status !== 'pending')
    if (task && hasRecordedProgress) return deriveTaskLane(task, lanes)
    return cardLanes[taskId]
      || (task ? deriveTaskLane(task, lanes) : lanes[0]?.key || 'do')
  }, [cardLanes, lanes, tasks])

  const visibleTasks = useMemo(
    () => selectWorkflowTasks(tasks, activeWorkflowId, showArchived),
    [tasks, activeWorkflowId, showArchived],
  )

  const tasksByLane = useMemo(() => {
    const map: Record<string, typeof visibleTasks> = {}
    lanes.forEach((l) => { map[l.key] = [] })
    visibleTasks.forEach((t: any) => {
      const lane = getCardLane(t.id)
      if (map[lane]) map[lane].push(t)
      else if (lanes[0]) map[lanes[0].key]?.push(t)
    })
    return map
  }, [visibleTasks, lanes, getCardLane])

  const anyRunning = useMemo(
    () => visibleTasks.some((task: any) => (task.status || 'ready') === 'running'),
    [visibleTasks],
  )
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    setDurationNowMs(Date.now())
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyRunning])

  const handleSelectTask = (taskId: string) => {
    setActiveTask(taskId)
    openTask(taskId, activeProject?.name, activeWorkflowId || undefined)
  }

  const copyWorkflowId = async () => {
    const ok = await copyText(activeWorkflowId || 'default')
    if (ok) {
      setCopiedWorkflowId(true)
      setTimeout(() => setCopiedWorkflowId(false), 1500)
    }
  }

  const handleStartConfirm = async () => {
    if (!confirmStartTaskId || !activeProject || startingTaskId) return
    const taskId = confirmStartTaskId
    setConfirmStartTaskId(null)
    setStartingTaskId(taskId)
    try {
      await runTask(taskId, '', activeProject.id)
      await fetchTasks(activeProject.id, activeWorkflowId)
    } catch (error) {
      setDirectoryNotice(
        t('taskList.startFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    } finally {
      setStartingTaskId(null)
    }
  }

  const handleDeleteConfirm = async (deleteWorkspace: boolean) => {
    if (!confirmDeleteTaskId || !activeProject || deletingTask) return
    setDeletingTask(true)
    try {
      await deleteTask(confirmDeleteTaskId, activeProject.id, deleteWorkspace)
      setCardLanes((prev) => { const next = { ...prev }; delete next[confirmDeleteTaskId]; return next })
      setConfirmDeleteTaskId(null)
    } catch (error) {
      setDirectoryNotice(t('taskList.bulkDeleteFailed', { error: error instanceof Error ? error.message : t('common.unknownError') }))
    } finally { setDeletingTask(false) }
  }

  const handleUnarchive = async (taskId: string) => {
    if (!activeProject) return
    try {
      await unarchiveTask(taskId, activeProject.id)
    } catch (error) {
      setDirectoryNotice(
        t('taskList.restoreFailed', { error: error instanceof Error ? error.message : t('common.unknownError') })
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    }
  }

  // Drag handlers
  const onDragStart = (e: React.DragEvent, taskId: string) => {
    setDragId(taskId);
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDragEnd = () => {
    setDragId(null)
    setDragOverLane(null)
  }

  const onDragOver = (e: React.DragEvent, laneKey: string) => {
    e.preventDefault()
    setDragOverLane(laneKey)
  }

  const onDragLeave = () => { setDragOverLane(null) }

  const onDrop = (e: React.DragEvent, laneKey: string) => {
    e.preventDefault()
    setDragOverLane(null)
    if (dragId) {
      setCardLanes((prev) => ({ ...prev, [dragId]: laneKey }))
    }
    setDragId(null)
  }

  return (
    <>
      {/* Topbar */}
      {compact && <div className="mobile-task-toolbar">
        <strong>{activeWorkflowName || t('mobile.taskList')}</strong>
        {canCreateTask && <Button className="mobile-task-new-button" variant="primary" onClick={() => openNewPanel()} disabled={!activeWorkflowId}>{t('taskList.new')}</Button>}
        <button
          className="mobile-session-kebab mobile-toolbar-icon-button"
          aria-label={t('layout.moreActions')}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
        >
          <Icon name="ellipsis" size={20} />
        </button>
      </div>}
      <MobileSheet open={compact && filtersOpen} title={t('mobile.filters')} onClose={() => setFiltersOpen(false)}>
        <div className="mobile-task-menu">
          <Select value={mobileStep} onChange={event => setMobileStep(event.target.value)} aria-label={t('mobile.steps')}>
            <option value="">{t('mobile.allSteps')}</option>
            {lanes.map(lane => <option key={lane.key} value={lane.key}>{lane.label}</option>)}
          </Select>
          <Button onClick={() => { setShowArchived(!showArchived); setFiltersOpen(false) }}>
            <Icon name="archive" size={16} />
            {showArchived ? t('mobile.activeTasks') : t('mobile.archivedTasks')}
          </Button>
          <Button onClick={() => { setFiltersOpen(false); navigate(`/canvas?project=${encodeURIComponent(activeProject?.name || '')}&workflow=${activeWorkflowId || ''}`) }}>
            <Icon name="workflow" size={16} />
            {t('taskList.stepEdit')}
          </Button>
          <Button onClick={() => { setFiltersOpen(false); setShortcutSettingsOpen(true) }} disabled={!activeWorkflowId || !canEdit || bound}>
            <Icon name="zap" size={16} />
            {t('actionShortcuts.quickButtons')}
          </Button>
          <Button className="workflow-hooks-entry" onClick={() => { setFiltersOpen(false); setHooksOpen(true) }} disabled={!activeWorkflowId || !canEdit}>
            <Icon name="webhook" size={16} />
            {t('workflowHooks.title')}
          </Button>
          <Button onClick={() => { setFiltersOpen(false); setShowScheduleDialog(true) }} disabled={bound}>
            <Icon name="clock" size={16} />
            {t('schedules.title')}
          </Button>
          <MobileOpenLocationButton disabled={!activeProject} onClick={() => { setFiltersOpen(false); setShowMobileDirectoryBrowser(true) }} />
          <ProjectGitButton project={activeProject} />
          <Button onClick={() => { setFiltersOpen(false); setShowSettingsPanel(true) }}>
            <Icon name="settings" size={16} />
            {t('taskList.settings')}
          </Button>
        </div>
      </MobileSheet>
      {showMobileDirectoryBrowser && activeProject && (
        <ProjectDirectoryBrowserDialog
          projectId={activeProject.id}
          title={activeProject.name}
          displayPath={t('browser.projectRoot')}
          onClose={() => setShowMobileDirectoryBrowser(false)}
        />
      )}
      <div className="desktop-task-toolbar" style={topbarStyle}>
        <Button
          variant="ghost"
          onClick={() => {
            const params = new URLSearchParams({
              project: activeProject?.name || '',
            })
            if (activeWorkflowId) params.set('workflow', activeWorkflowId)
            navigate(`/canvas?${params.toString()}`)
          }}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="table" size={14} strokeWidth={2} />
          {t('taskList.stepEdit')}
        </Button>
        {canCreateTask && !showArchived && (
          <Button variant="primary" onClick={() => openNewPanel()} style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}>
            <Icon name="plus" size={14} strokeWidth={2.5} />
            {t('taskList.new')}
          </Button>
        )}
        {activeWorkflowName && (
          <span
            title={activeWorkflowName}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 'calc(13px * var(--font-scale))', color: 'var(--fg-2)', fontWeight: 500,
              maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <Icon name="workflow" size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
            {activeWorkflowName}
          </span>
        )}
        {activeProject && (
          <button
            type="button"
            title={copiedWorkflowId ? t('common.copied') : t('taskList.copyWorkflowIdTitle')}
            aria-label={t('taskList.copyWorkflowIdAria')}
            onClick={() => void copyWorkflowId()}
            style={{
              color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap', background: 'none', border: 'none',
              padding: '4px 6px', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            {copiedWorkflowId ? t('common.copied') : `ID: ${activeWorkflowId || 'default'}`}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {directoryNotice && (
          <span
            role="status"
            style={{
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))',
            }}
            title={directoryNotice}
          >
            {directoryNotice}
          </span>
        )}
        {managedMode !== true && activeProject && activeProject.type !== 'remote' && (
          <Button
            variant="ghost"
            onClick={() => setShowShareDialog(true)}
            title={t('layout.remoteShareTitle')}
            style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
          >
            <Icon name="share" size={13} strokeWidth={2} />
            {t('layout.remoteShareTitle')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => setShortcutSettingsOpen(true)}
          disabled={!activeWorkflowId || !canEdit || bound}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          {t('actionShortcuts.quickButtons')}
        </Button>
        <Button variant="ghost" className="workflow-hooks-entry workflow-hooks-entry--toolbar" onClick={() => setHooksOpen(true)} disabled={!activeWorkflowId || !canEdit}>
          <Icon name="webhook" size={13} />
          {t('workflowHooks.title')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowScheduleDialog(true)}
          disabled={!activeProject || bound}
          title={t('schedules.openTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="clock" size={13} strokeWidth={2} />
          {t('schedules.title')}{scheduleCount > 0 && `(${scheduleCount})`}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setMemoryOpen(true)}
          disabled={!activeProject || bound}
          title={t('taskList.memoryButtonTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="book" size={13} strokeWidth={2} />
          {t('taskList.memory')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowArchived((value) => !value)}
          disabled={!activeProject}
          title={showArchived ? t('canvas.backBoardTitle') : t('taskList.viewArchivedTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="archive" size={13} strokeWidth={2} />
          {showArchived ? t('taskList.backBoard') : t('taskList.viewArchived')}
        </Button>
        <div
          role="group"
          aria-label={boardView === 'lanes' ? t('taskList.viewLanes') : t('taskList.viewTable')}
          style={{ display: 'inline-flex', gap: 2, padding: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius-pill)', background: 'var(--bg)' }}
        >
          <button
            type="button"
            title={t('taskList.viewLanes')}
            aria-label={t('taskList.viewLanes')}
            aria-pressed={boardView === 'lanes'}
            disabled={!activeProject}
            onClick={() => setBoardView('lanes')}
            style={viewToggleButtonStyle(boardView === 'lanes', !activeProject)}
          >
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
              <rect x="1.5" y="2" width="4" height="12" rx="1" />
              <rect x="6.5" y="2" width="4" height="8" rx="1" />
              <rect x="11.5" y="2" width="4" height="10" rx="1" />
            </svg>
          </button>
          <button
            type="button"
            title={t('taskList.viewTable')}
            aria-label={t('taskList.viewTable')}
            aria-pressed={boardView === 'table'}
            disabled={!activeProject}
            onClick={() => setBoardView('table')}
            style={viewToggleButtonStyle(boardView === 'table', !activeProject)}
          >
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <line x1="1.5" y1="6.2" x2="14.5" y2="6.2" />
              <line x1="1.5" y1="9.8" x2="14.5" y2="9.8" />
            </svg>
          </button>
        </div>
        <OpenLocationButton
          activeProject={activeProject}
          t={t}
          showInlineNotice={false}
          onNoticeChange={setDirectoryNotice}
        />
        <ProjectGitButton project={activeProject} />
        <Button
          variant="ghost"
          onClick={() => setShowSettingsPanel(true)}
          disabled={!activeProject}
          title={t('taskList.settingsTitle')}
          style={{ fontSize: 'calc(13px * var(--font-scale))', gap: 5 }}
        >
          <Icon name="settings" size={13} strokeWidth={2} />
          {t('taskList.settings')}
        </Button>
      </div>

      {/* Archive-view banner */}
      {showArchived && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '8px 20px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)',
          background: 'color-mix(in oklab, var(--accent), transparent 94%)',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <Icon name="archive" size={13} strokeWidth={2} />
          {t('taskList.viewingArchived')}
          <span style={{ marginLeft: 'auto', fontSize: 'calc(13px * var(--font-scale))' }}>
            {t('taskList.taskCount', { count: visibleTasks.length })}
          </span>
        </div>
      )}

      {/* Kanban board */}
      {compact && <div className="mobile-task-list">
        {loading && <div role="status">{t('common.loading')}</div>}
        {!loading && visibleTasks.filter(task => !mobileStep || getCardLane(task.id) === mobileStep).length === 0 && <p className="mobile-empty">{t('mobile.emptyTasks')}</p>}
        {visibleTasks.filter(task => !mobileStep || getCardLane(task.id) === mobileStep).map(task => <button className="mobile-task-row" key={task.id} onClick={() => handleSelectTask(task.id)}>
          <span className="mobile-task-row-title">{task.title}</span>
          <span className="mobile-task-row-meta"><StatusBadge status={task.status} loading={['running', 'reviewing', 'retrying'].includes(task.status)} label={t(`status.${task.status === 'completed' ? 'passed' : task.status || 'ready'}` as 'status.ready')} />{task.creator_name && <span>{t('taskList.creator')}：{task.creator_name}</span>}<span>{lanes.find(lane => lane.key === getCardLane(task.id))?.label}</span><time>{new Date(task.updated_at || task.created_at).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>
        </button>)}
      </div>}
      <div className={`desktop-task-board ${boardView === 'lanes' ? 'task-board-lanes' : 'task-board-table'}`}>
        {loading && (
          <div className="task-board-loading">
            {t('common.loading')}
          </div>
        )}

        {!loading && !activeProject && (
          <EmptyState
            className="empty-state-canvas"
            icon={<Icon name="folder" size={48} strokeWidth={1.5} />}
            title={t('taskList.selectProjectEmpty')}
          />
        )}

        {!loading && activeProject && boardView === 'lanes' && lanes.map((lane) => {
          const laneTasks = tasksByLane[lane.key] || []
          return (
            <div key={lane.key} className="task-board-lane" style={{ '--task-lane-color': lane.color } as React.CSSProperties}>
              <div className="task-board-lane-header">
                <div className="task-board-lane-heading">
                  <span className="task-board-lane-dot" />
                  {lane.label}
                  <span className="task-board-lane-count">({laneTasks.length})</span>
                </div>
                {canCreateTask && !showArchived && (
                  <Button
                    variant="ghost"
                    aria-label={t('taskList.addTaskToLane', { lane: lane.label })}
                    title={t('taskList.addTaskToLane', { lane: lane.label })}
                    onClick={() => openNewPanel(lane.key)}
                    className="task-board-lane-add"
                  >
                    {t('taskList.add')}
                  </Button>
                )}
              </div>
              <div
                className="task-board-lane-body"
                data-drag-over={dragOverLane === lane.key || undefined}
                onDragOver={(e) => onDragOver(e, lane.key)}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, lane.key)}
              >
                {laneTasks.map((task) => <TaskBoardCard
                  key={task.id}
                  task={task}
                  durationNowMs={durationNowMs}
                  showArchived={showArchived}
                  starting={startingTaskId === task.id}
                  readOnly={!canEdit}
                  dragging={dragId === task.id}
                  onOpen={() => handleSelectTask(task.id)}
                  onStart={() => setConfirmStartTaskId(task.id)}
                  onArchive={() => setArchiveTarget({ id: task.id, title: task.title })}
                  onRestore={() => { void handleUnarchive(task.id) }}
                  onDelete={() => setConfirmDeleteTaskId(task.id)}
                  onDragStart={(event) => onDragStart(event, task.id)}
                  onDragEnd={onDragEnd}
                />)}
              </div>
            </div>
          )
        })}

        {/* Grouped table view with multi-select bulk actions. */}
        {!loading && activeProject && boardView === 'table' && (
          <TaskTableView
            key={`${activeProject.id}:${showArchived}`}
            readOnly={!canEdit}
            canCreateTask={canCreateTask}
            lanes={lanes}
            tasksByLane={tasksByLane}
            showArchived={showArchived}
            durationNowMs={durationNowMs}
            onOpenTask={handleSelectTask}
            onAddTask={openNewPanel}
            onArchiveTask={(taskId) => archiveTask(taskId, activeProject.id)}
            onDeleteTask={(taskId, deleteWorkspace) => deleteTask(taskId, activeProject.id, deleteWorkspace)}
            onError={(message) => {
              setDirectoryNotice(message)
              setTimeout(() => setDirectoryNotice(''), 3000)
            }}
          />
        )}
      </div>

      {canCreateTask && createRequest && activeProject && (
        <TaskCreatePanel
          key={createRequest.id}
          project={activeProject}
          workflowId={activeWorkflowId}
          lanes={lanes}
          initialStepKey={createRequest.stepKey}
          onClose={() => setCreateRequest(null)}
        />
      )}

      {/* ── Schedule dialog ── */}
      {hooksOpen && activeProject && activeWorkflowId && <WorkflowHookManagerDialog key={`${activeProject.id}:${activeWorkflowId}`} projectId={activeProject.id} workflowId={activeWorkflowId} workflowName={activeWorkflowName || ""} onClose={() => setHooksOpen(false)} />}
      {shortcutSettingsOpen && activeProject && activeWorkflowId && <WorkflowShortcutSettingsDialog
        key={`${activeProject.id}:${activeWorkflowId}`}
        projectId={activeProject.id}
        workflowId={activeWorkflowId}
        workflowName={activeWorkflowName || ''}
        workflowButtons={Array.isArray(activeProject.steps?.quickButtons) ? activeProject.steps.quickButtons : []}
        selectedIds={Array.isArray(activeProject.steps?.projectQuickButtonIds) ? activeProject.steps.projectQuickButtonIds : undefined}
        inheritByDefault={activeProject.steps?.inheritProjectQuickButtons === true}
        onClose={() => setShortcutSettingsOpen(false)}
        onSave={async (selectedIds, workflowButtons) => {
          await saveSteps(activeProject.id, { ...activeProject.steps, projectQuickButtonIds: selectedIds, quickButtons: workflowButtons })
        }}
      />}
      {showScheduleDialog && (
        <div
          className="modal-overlay schedule-dialog-overlay"
          role="presentation"
          style={{ zIndex: 1000, padding: 12 }}
        >
          <ResizablePanel
            className="modal schedule-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('schedules.title')}
            style={{ width: 'min(1500px, 96vw)', height: 'min(1080px, calc(100dvh - 24px))', maxHeight: 'calc(100dvh - 24px)' }}
          >
            <SchedulePage
              onClose={() => setShowScheduleDialog(false)}
              onCountChange={setScheduleCount}
            />
          </ResizablePanel>
        </div>
      )}

      <ProjectShareDialog
        project={managedMode !== true && showShareDialog ? activeProject : null}
        onClose={() => setShowShareDialog(false)}
      />

      <ProjectSettingsPanel
        project={showSettingsPanel ? activeProject : null}
        onClose={() => setShowSettingsPanel(false)}
        onProjectRenamed={(name) => {
          if (activeProject) void renameProject(activeProject.path, name)
        }}
      />

      {/* ── Task detail slide-in panel from right ── */}
      {selectedTaskId && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeTask}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
          />
          <TaskDetail
            taskId={selectedTaskId}
            onClose={closeTask}
          />
        </>
      )}

      {/* ── Delete confirm dialog ── */}
      <ConfirmDialog
        open={confirmStartTaskId !== null}
        title={t('taskList.startTask')}
        message={t('taskList.startTaskMessage', {
          title: tasks.find((task) => task.id === confirmStartTaskId)?.title || t('taskList.thatTask'),
        })}
        confirmText={t('taskList.start')}
        onConfirm={handleStartConfirm}
        onCancel={() => setConfirmStartTaskId(null)}
      />

      <DeleteTaskConfirmation
        open={confirmDeleteTaskId !== null}
        count={1}
        busy={deletingTask}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDeleteTaskId(null)}
      />

      {archiveTarget && <ArchiveExperienceDialog key={archiveTarget.id}
        task={archiveTarget} projectId={activeProject?.id}
        onClose={() => setArchiveTarget(null)}
        onArchived={(taskId) => {
          setCardLanes((prev) => { const next = { ...prev }; delete next[taskId]; return next })
          setArchiveTarget(null)
        }} />}

      {memoryOpen && activeProject && (
        <ProjectMemoryPanel key={activeProject.id} projectId={activeProject.id}
          onClose={() => setMemoryOpen(false)} />
      )}
    </>
  )
}
