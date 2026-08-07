import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { fsApi, type DirectoryOpener } from '../api/client'
import TaskDetail from './TaskDetail'
import { isTaskCompleted, isTaskNotStarted } from './taskDetailChat'
import ConfirmDialog from '../components/ConfirmDialog'
import MarkdownEditor from '../components/MarkdownEditor'

/* ── Styles ── */
const topbarStyle: React.CSSProperties = {
  height: 48, background: 'var(--bg)',
  borderBottom: '1px solid var(--border-soft)',
  display: 'flex', alignItems: 'center',
  padding: '0 20px', gap: 12, flexShrink: 0,
}

const kanbanStyle: React.CSSProperties = {
  flex: 1, display: 'flex', gap: 0,
  overflowX: 'scroll', overflowY: 'hidden',
  padding: '16px 16px 16px 0',
}

const laneStyle: React.CSSProperties = {
  minWidth: 260, maxWidth: 320, flexShrink: 0,
  background: 'var(--surface)', borderRadius: 'var(--radius-md)',
  display: 'flex', flexDirection: 'column',
  marginRight: 12, overflow: 'hidden',
}

const laneBodyStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto',
  padding: '4px 10px 10px',
  display: 'flex', flexDirection: 'column', gap: 8,
  minHeight: 120,
}

/* ── Status machine ── */
const STATUS_LABELS: Record<string, string> = {
  ready: '预备中', running: '进行中', paused: '暂停', stopped: '停止',
  done: '已完成',
  reviewing: '审核中', awaiting_review: '等待审核',
  retrying: '自动重跑', rejected: '审核未通过',
  rework: '返工中', rework_waiting: '等待返工',
}

const STATUS_COLORS: Record<string, string> = {
  ready: 'var(--status-ready)',
  running: 'var(--status-running)',
  paused: 'var(--status-paused)',
  stopped: 'var(--status-stopped)',
  passed: 'var(--status-done)',
  failed: 'var(--status-failed)',
  reviewing: 'var(--accent)',
  awaiting_review: 'var(--status-paused)',
  retrying: 'var(--warn)',
  rejected: 'var(--status-failed)',
  rework: 'var(--warn)',
  rework_waiting: 'var(--warn)',
}

/* ── Extract lanes from steps.json ── */
interface Lane { key: string; label: string; color: string }

/* ── Default colors for known stage keys ── */
const STAGE_COLORS: Record<string, string> = {
  req: '#0071e3', ui: '#7c3aed', frontend: '#059669',
  backend: '#d97706', test: '#dc2626', deploy: '#16a34a',
}

const FALLBACK_OPENERS: DirectoryOpener[] = [
  { id: 'file_manager', label: '打开位置', available: true },
]

function OpenerIcon({ id }: { id: string }) {
  const visual: Record<string, { text: string; bg: string; color: string }> = {
    vscode: { text: '⌁', bg: '#eaf6ff', color: '#168bd2' },
    sublime: { text: 'S', bg: '#333', color: '#ff9800' },
    file_manager: { text: '⌂', bg: '#eaf4ff', color: '#2684ff' },
    terminal: { text: '>_', bg: '#454545', color: '#fff' },
    iterm: { text: '$', bg: '#3e2945', color: '#59e391' },
    intellij: { text: 'IJ', bg: '#ef476f', color: '#fff' },
    pycharm: { text: 'PC', bg: '#32c787', color: '#fff' },
  }
  const item = visual[id] || visual.file_manager
  return (
    <span style={{
      width: 20, height: 20, borderRadius: 5, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: item.bg, color: item.color, fontSize: id === 'terminal' ? 8 : 10,
      fontWeight: 700, lineHeight: 1,
    }}>
      {item.text}
    </span>
  )
}

function getLanesFromSteps(steps: any): Lane[] {
  if (steps?.nodes?.length) {
    return steps.nodes.map((n: any) => {
      const key = n.type || n.key || String(n.id)
      return {
        key,
        label: n.title || n.label || n.type,
        color: n.color || STAGE_COLORS[key] || '#888',
      }
    })
  }
  if (steps?.steps?.length) {
    return steps.steps.map((s: any) => ({
      key: s.key || s.id,
      label: s.label || s.name || s.key,
      color: s.color || '#888',
    }))
  }
  return [{ key: 'do', label: '执行', color: '#0071e3' }]
}

function deriveTaskLane(
  task: { steps?: Array<{ step_key: string; status: string }> },
  lanes: Lane[],
): string {
  const laneKeys = new Set(lanes.map((lane) => lane.key))
  const steps = task.steps || []
  const findLane = (status: string) =>
    steps.find((step) => step.status === status && laneKeys.has(step.step_key))?.step_key

  // Keep this priority aligned with the task detail's "current stage" rule.
  return findLane('reviewing')
    || findLane('awaiting_review')
    || findLane('retrying')
    || findLane('rework_waiting')
    || findLane('rework')
    || findLane('running')
    || findLane('rejected')
    || findLane('failed')
    || findLane('pending')
    || [...steps].reverse().find(
      (step) => laneKeys.has(step.step_key)
        && (step.status === 'passed' || step.status === 'skipped')
    )?.step_key
    || lanes[0]?.key
    || 'do'
}

export default function TaskList() {
  const navigate = useNavigate()
  const {
    tasks, loading, fetchTasks, createTask, runTask, deleteTask,
    archiveTask, unarchiveTask, setActiveTask,
  } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const activeWorkflowId = useProjectStore((s) => s.activeWorkflowId)
  const activeWorkflowName = activeProject?.workflows?.find((w) => w.id === activeWorkflowId)?.name
  const [showNewPanel, setShowNewPanel] = useState(false)
  const [createStartStepKey, setCreateStartStepKey] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null)
  const [confirmStartTaskId, setConfirmStartTaskId] = useState<string | null>(null)
  const [confirmArchiveTaskId, setConfirmArchiveTaskId] = useState<string | null>(null)
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [createError, setCreateError] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'review'>('content')
  const [newDesc, setNewDesc] = useState('')
  const [newAutoStart, setNewAutoStart] = useState(false)
  const [dragOverLane, setDragOverLane] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [copiedWorkflowId, setCopiedWorkflowId] = useState(false)
  const [showMemoryPanel, setShowMemoryPanel] = useState(false)
  const [memoryContent, setMemoryContent] = useState('')
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memorySaving, setMemorySaving] = useState(false)
  const [memoryError, setMemoryError] = useState('')
  const [memoryNotice, setMemoryNotice] = useState('')
  const [confirmCloseMemory, setConfirmCloseMemory] = useState(false)
  const [confirmCloseNewTask, setConfirmCloseNewTask] = useState(false)
  const memorySavedRef = useRef('')
  const newPanelBaselineRef = useRef<{
    title: string
    desc: string
    autoStart: boolean
    overrides: Record<string, { auto: boolean; prompt: string; maxRetries: number }>
  }>({ title: '', desc: '', autoStart: false, overrides: {} })
  const [directoryNotice, setDirectoryNotice] = useState('')
  const [directoryOpeners, setDirectoryOpeners] = useState<DirectoryOpener[]>(FALLBACK_OPENERS)
  const [selectedOpener, setSelectedOpener] = useState(
    () => localStorage.getItem('workstep-directory-opener') || 'file_manager'
  )
  const [showOpenerMenu, setShowOpenerMenu] = useState(false)
  const openerMenuRef = useRef<HTMLDivElement>(null)
  // Local lane override for unstarted cards moved manually in the board.
  const [cardLanes, setCardLanes] = useState<Record<string, string>>({})
  const tasksFetchedRef = useRef<string>('')

  useEffect(() => {
    if (!activeProject?.id) { tasksFetchedRef.current = ''; return }
    if (tasksFetchedRef.current === activeProject.id) return
    tasksFetchedRef.current = activeProject.id
    fetchTasks(activeProject.id, activeWorkflowId, showArchived)
  }, [fetchTasks, activeProject?.id, showArchived])

  useEffect(() => {
    if (activeProject?.id) fetchTasks(activeProject.id, activeWorkflowId, showArchived)
  }, [fetchTasks, activeProject?.id, activeWorkflowId, showArchived])

  // Reset local state when project changes
  useEffect(() => {
    setCardLanes({})
    setShowNewPanel(false)
    setCreateStartStepKey(null)
    setShowArchived(false)
  }, [activeProject?.path])

  useEffect(() => {
    fsApi.directoryOpeners()
      .then(({ openers }) => {
        const available = openers.filter((opener) => opener.available)
        setDirectoryOpeners(available.length ? available : FALLBACK_OPENERS)
        if (!available.some((opener) => opener.id === selectedOpener)) {
          setSelectedOpener('file_manager')
          localStorage.setItem('workstep-directory-opener', 'file_manager')
        }
      })
      .catch(() => setDirectoryOpeners(FALLBACK_OPENERS))
  }, [selectedOpener])

  useEffect(() => {
    if (!showOpenerMenu) return
    const closeMenu = (event: MouseEvent) => {
      if (!openerMenuRef.current?.contains(event.target as Node)) {
        setShowOpenerMenu(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowOpenerMenu(false)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showOpenerMenu])

  const lanes = useMemo(() => getLanesFromSteps(activeProject?.steps), [activeProject?.steps])
  const createLane = lanes.find((lane) => lane.key === createStartStepKey) || lanes[0]
  const createLaneIndex = Math.max(0, lanes.findIndex((lane) => lane.key === createLane?.key))

  const [reviewOverrides, setReviewOverrides] = useState<Record<string, { auto: boolean; prompt: string; maxRetries: number }>>({})

  const openNewPanel = (stepKey?: string) => {
    const selectedStepKey = stepKey || lanes[0]?.key || null
    setCreateStartStepKey(selectedStepKey)
    setNewTitle('')
    setNewDesc('')
    setCreateError('')
    setActiveTab('content')
    // Initialize review overrides from canvas stage config
    const nodeConfigs: Record<string, { auto: boolean; prompt: string; maxRetries: number }> = {}
    const canvasSteps = activeProject?.steps
    const selectedStage = [
      ...(canvasSteps?.nodes || []),
      ...(canvasSteps?.steps || []),
    ].find((stage: any) => (
      stage.type || stage.key || String(stage.id)
    ) === selectedStepKey)
    setNewAutoStart(Boolean(selectedStage?.autoStart))
    if (canvasSteps?.nodes) {
      for (const n of canvasSteps.nodes) {
        const key = (n.type || n.key || String(n.id)) as string
        const rv = n.review || {}
        nodeConfigs[key] = {
          auto: !!rv.auto,
          prompt: String(rv.prompt || ''),
          maxRetries: Math.max(1, Math.min(5, Number(rv.maxRetries) || 1)),
        }
      }
    }
    setReviewOverrides(nodeConfigs)
    newPanelBaselineRef.current = {
      title: '',
      desc: '',
      autoStart: Boolean(selectedStage?.autoStart),
      overrides: JSON.parse(JSON.stringify(nodeConfigs)),
    }
    setShowNewPanel(true)
  }

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
    () => tasks.filter((t) => (showArchived ? t.archived : !t.archived)),
    [tasks, showArchived],
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

  const handleCreate = async () => {
    if (!newTitle.trim() || !activeProject) return
    try {
      await createTask(
        newTitle.trim(),
        activeProject.path,
        activeProject.id,
        newDesc.trim() || undefined,
        createLane?.key,
        Object.keys(reviewOverrides).length > 0 ? reviewOverrides : undefined,
        activeWorkflowId,
        newAutoStart,
      )
      setNewTitle('')
      setNewDesc('')
      setShowNewPanel(false)
      setCreateError('')
    } catch (e: any) {
      setCreateError(e?.message || '创建任务失败，请检查后台服务是否正常')
    }
  }

  const handleSelectTask = (taskId: string) => {
    setActiveTask(taskId)
    setSelectedTaskId(taskId)
  }

  const openProjectDirectory = async (openerId = selectedOpener) => {
    if (!activeProject) return
    try {
      const result = await fsApi.openDirectory(activeProject.path, openerId)
      setDirectoryNotice(`已打开：${result.path}`)
    } catch (error) {
      setDirectoryNotice(
        `打开失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    }
    setTimeout(() => setDirectoryNotice(''), 3000)
  }

  const copyWorkflowId = async () => {
    try {
      await navigator.clipboard.writeText(activeWorkflowId || 'default')
      setCopiedWorkflowId(true)
      setTimeout(() => setCopiedWorkflowId(false), 1500)
    } catch {
      // Clipboard unavailable — leave state untouched.
    }
  }

  const openMemoryPanel = async () => {
    setShowMemoryPanel(true)
    setMemoryError('')
    setMemoryNotice('')
    if (!activeProject) return
    setMemoryLoading(true)
    try {
      const result = await fsApi.readMemory(activeProject.id)
      setMemoryContent(result.content)
      memorySavedRef.current = result.content
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : '读取记忆失败')
    } finally {
      setMemoryLoading(false)
    }
  }

  const handleSaveMemory = async () => {
    if (!activeProject || memorySaving) return
    setMemorySaving(true)
    setMemoryError('')
    setMemoryNotice('')
    try {
      await fsApi.saveMemory(activeProject.id, memoryContent)
      memorySavedRef.current = memoryContent
      setShowMemoryPanel(false)
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : '保存记忆失败')
    } finally {
      setMemorySaving(false)
    }
  }

  const closeNewPanel = () => {
    const baseline = newPanelBaselineRef.current
    const dirty = newTitle !== baseline.title
      || newDesc !== baseline.desc
      || newAutoStart !== baseline.autoStart
      || JSON.stringify(reviewOverrides) !== JSON.stringify(baseline.overrides)
    if (dirty) {
      setConfirmCloseNewTask(true)
    } else {
      setShowNewPanel(false)
    }
  }

  const closeMemoryPanel = () => {
    if (memoryContent !== memorySavedRef.current) {
      setConfirmCloseMemory(true)
    } else {
      setShowMemoryPanel(false)
    }
  }

  const selectDirectoryOpener = (opener: DirectoryOpener) => {
    setSelectedOpener(opener.id)
    localStorage.setItem('workstep-directory-opener', opener.id)
    setShowOpenerMenu(false)
    void openProjectDirectory(opener.id)
  }

  const deleteCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmDeleteTaskId(taskId)
  }

  const requestStartCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmStartTaskId(taskId)
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
        `启动失败：${error instanceof Error ? error.message : '未知错误'}`
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    } finally {
      setStartingTaskId(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (confirmDeleteTaskId && activeProject) {
      await deleteTask(confirmDeleteTaskId, activeProject.id)
      setCardLanes((prev) => { const next = { ...prev }; delete next[confirmDeleteTaskId]; return next })
      setConfirmDeleteTaskId(null)
    }
  }

  const requestArchiveCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmArchiveTaskId(taskId)
  }

  const handleArchiveConfirm = async () => {
    if (!confirmArchiveTaskId || !activeProject) return
    const taskId = confirmArchiveTaskId
    setConfirmArchiveTaskId(null)
    try {
      await archiveTask(taskId, activeProject.id)
      setCardLanes((prev) => { const next = { ...prev }; delete next[taskId]; return next })
    } catch (error) {
      setDirectoryNotice(
        `归档失败：${error instanceof Error ? error.message : '未知错误'}`
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    }
  }

  const handleUnarchive = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    if (!activeProject) return
    try {
      await unarchiveTask(taskId, activeProject.id)
    } catch (error) {
      setDirectoryNotice(
        `恢复失败：${error instanceof Error ? error.message : '未知错误'}`
      )
      setTimeout(() => setDirectoryNotice(''), 3000)
    }
  }

  // Drag handlers
  const onDragStart = (e: React.DragEvent, taskId: string) => {
    setDragId(taskId);
    (e.currentTarget as HTMLElement).style.opacity = '0.4'
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = '1';
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
      <div style={topbarStyle}>
        <button
          className="btn-ghost"
          onClick={() => {
            const params = new URLSearchParams({
              project: activeProject?.name || '',
            })
            if (activeWorkflowId) params.set('workflow', activeWorkflowId)
            navigate(`/canvas?${params.toString()}`)
          }}
          style={{ fontSize: 13, gap: 5 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          阶段编辑
        </button>
        {!showArchived && (
          <button className="btn-primary" onClick={() => openNewPanel()} style={{ fontSize: 13, gap: 5 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            新建
          </button>
        )}
        {activeWorkflowName && (
          <span
            title={activeWorkflowName}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 13, color: 'var(--fg-2)', fontWeight: 500,
              maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
            </svg>
            {activeWorkflowName}
          </span>
        )}
        {activeProject && (
          <button
            type="button"
            title={copiedWorkflowId ? '已复制' : '点击复制流程 ID'}
            aria-label="复制流程 ID"
            onClick={() => void copyWorkflowId()}
            style={{
              color: 'var(--meta)', fontSize: 11, fontFamily: 'var(--font-mono)',
              whiteSpace: 'nowrap', background: 'none', border: 'none',
              padding: '4px 6px', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            {copiedWorkflowId ? '已复制' : `ID: ${activeWorkflowId || 'default'}`}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {directoryNotice && (
          <span
            role="status"
            style={{
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', color: 'var(--meta)', fontSize: 13,
            }}
            title={directoryNotice}
          >
            {directoryNotice}
          </span>
        )}
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void openMemoryPanel()}
          disabled={!activeProject}
          title="编辑 .workstep/MEMORY.md 项目记忆"
          style={{ fontSize: 13, gap: 5 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
          记忆
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setShowArchived((value) => !value)}
          disabled={!activeProject}
          title={showArchived ? '返回任务看板' : '查看已归档任务'}
          style={{ fontSize: 13, gap: 5 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="5" rx="1"/>
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>
            <path d="M10 12h4"/>
          </svg>
          {showArchived ? '返回看板' : '查看归档'}
        </button>
        <div ref={openerMenuRef} style={{ display: 'flex', position: 'relative' }}>
          <button
            className="btn-ghost"
            onClick={() => void openProjectDirectory()}
            disabled={!activeProject}
            title={activeProject ? `使用${directoryOpeners.find((item) => item.id === selectedOpener)?.label || '文件管理器'}打开：${activeProject.path}` : '请先选择项目'}
            style={{
              fontSize: 13, gap: 6, borderTopRightRadius: 0,
              borderBottomRightRadius: 0, paddingRight: 10,
            }}
          >
            <OpenerIcon id={selectedOpener} />
            打开位置
          </button>
          <button
            className="btn-ghost"
            aria-label="选择打开方式"
            aria-expanded={showOpenerMenu}
            onClick={() => setShowOpenerMenu((value) => !value)}
            disabled={!activeProject}
            style={{
              width: 30, padding: 0, justifyContent: 'center',
              borderLeft: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>
          {showOpenerMenu && (
            <div
              role="menu"
              aria-label="打开项目目录方式"
              style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 1200,
                width: 230, padding: 8, background: 'var(--bg)',
                border: '1px solid var(--border)', borderRadius: 14,
                boxShadow: '0 14px 36px rgba(0,0,0,0.16)',
              }}
            >
              {directoryOpeners.map((opener) => (
                <button
                  key={opener.id}
                  role="menuitem"
                  onClick={() => selectDirectoryOpener(opener)}
                  style={{
                    width: '100%', height: 40, padding: '0 10px', gap: 10,
                    justifyContent: 'flex-start', borderRadius: 9,
                    background: opener.id === selectedOpener ? 'var(--surface)' : 'transparent',
                    color: 'var(--fg)', fontSize: 13,
                  }}
                >
                  <OpenerIcon id={opener.id} />
                  {opener.label}
                  {opener.id === selectedOpener && (
                    <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>✓</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Archive-view banner */}
      {showArchived && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          padding: '8px 20px', fontSize: 13, color: 'var(--meta)',
          background: 'color-mix(in oklab, var(--accent), transparent 94%)',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="5" rx="1"/>
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>
            <path d="M10 12h4"/>
          </svg>
          正在查看归档任务
          <span style={{ marginLeft: 'auto', fontSize: 13 }}>
            {visibleTasks.length} 个任务
          </span>
        </div>
      )}

      {/* Kanban board */}
      <div style={kanbanStyle}>
        {loading && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--meta)' }}>
            加载中...
          </div>
        )}

        {!loading && !activeProject && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--meta)', minWidth: '100%' }}>
            <div style={{ textAlign: 'center' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 12, opacity: 0.5 }}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <div style={{ fontSize: 13 }}>请在左侧选择一个项目</div>
            </div>
          </div>
        )}

        {!loading && activeProject && lanes.map((lane) => {
          const laneTasks = tasksByLane[lane.key] || []
          return (
            <div key={lane.key} style={laneStyle}>
              <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: lane.color }} />
                  {lane.label}
                  <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--meta)' }}>({laneTasks.length})</span>
                </div>
                {!showArchived && (
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-label={`添加${lane.label}任务`}
                    title={`添加${lane.label}任务`}
                    onClick={() => openNewPanel(lane.key)}
                    style={{ marginLeft: 'auto', height: 24, padding: '0 7px', fontSize: 11, flexShrink: 0 }}
                  >
                    + 添加
                  </button>
                )}
              </div>
              <div
                style={{
                  ...laneBodyStyle,
                  background: dragOverLane === lane.key ? 'color-mix(in oklab, var(--accent), transparent 94%)' : 'transparent',
                }}
                onDragOver={(e) => onDragOver(e, lane.key)}
                onDragLeave={onDragLeave}
                onDrop={(e) => onDrop(e, lane.key)}
              >
                {laneTasks.map((t: any) => {
                  const status = t.status || 'ready'
                  const taskNotStarted = isTaskNotStarted(t.steps || [])
                  const taskCompleted = isTaskCompleted(t.steps || [])
                  const isLastLane = lane.key === lanes[lanes.length - 1]?.key
                  const stageStatus = ['reviewing', 'awaiting_review', 'retrying', 'rejected']
                    .find((candidate) =>
                      (t.steps || []).some((step: any) => step.status === candidate)
                    )
                  const displayStatus = taskCompleted ? 'done' : stageStatus || status
                  const statusColor = STATUS_COLORS[displayStatus] || 'var(--status-ready)'
                  return (
                    <div
                      key={t.id}
                      data-task-status={status}
                      draggable={!showArchived}
                      onDragStart={(e) => onDragStart(e, t.id)}
                      onDragEnd={onDragEnd}
                      onClick={() => handleSelectTask(t.id)}
                      style={{
                        background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
                        padding: '10px 12px', cursor: 'grab',
                        borderLeft: `3px solid ${statusColor}`,
                        transition: 'box-shadow var(--motion-fast)',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 6px rgba(0,0,0,0.05)'
                        const actions = e.currentTarget.querySelector('.card-actions') as HTMLElement
                        if (actions) actions.style.opacity = '1'
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = 'none'
                        const actions = e.currentTarget.querySelector('.card-actions') as HTMLElement
                        if (actions) actions.style.opacity = '0'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', flex: 1 }}>{t.title}</span>
                        <span
                          className="status-badge"
                          data-s={displayStatus}
                          style={stageStatus ? {
                            color: statusColor,
                            background: `color-mix(in oklab, ${statusColor}, transparent 86%)`,
                          } : undefined}
                        >
                          {(displayStatus === 'running' || displayStatus === 'reviewing') && (
                            <span className="task-status-spinner" aria-hidden="true" />
                          )}
                          {STATUS_LABELS[displayStatus] || displayStatus}
                        </span>
                        {status === 'running' && (t.recovered_count || 0) > 0 && (
                          <span
                            title={`上次进程中断后已自动恢复续跑（累计 ${t.recovered_count} 次）`}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              fontSize: 11, fontWeight: 600, padding: '2px 7px',
                              borderRadius: 'var(--radius-pill)', whiteSpace: 'nowrap',
                              color: 'var(--accent)',
                              background: 'color-mix(in oklab, var(--accent), transparent 88%)',
                              border: '1px solid color-mix(in oklab, var(--accent), transparent 60%)',
                            }}
                          >
                            断点续跑
                          </span>
                        )}
                      </div>
                      {t.description && (
                        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.4, marginBottom: 8 }}>{t.description}</div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{
                          fontSize: 11, padding: '2px 7px', borderRadius: 'var(--radius-pill)', fontWeight: 500,
                          background: `color-mix(in oklab, ${lane.color}, transparent 90%)`,
                          color: lane.color,
                        }}>
                          {lane.label}
                        </span>
                        <div className="card-actions" style={{ display: 'flex', gap: 2, width: '100%', opacity: 0, transition: 'opacity var(--motion-fast)' }}>
                          {taskNotStarted && status !== 'running' && (
                            <button
                              className="btn-icon"
                              title="开始任务"
                              aria-label="开始任务"
                              disabled={startingTaskId === t.id}
                              onClick={(e) => requestStartCard(e, t.id)}
                              style={{ width: 22, height: 22, color: 'var(--success)' }}
                            >
                              ▶️
                            </button>
                          )}
                          <button className="btn-icon" title="编辑" onClick={(e) => { e.stopPropagation(); handleSelectTask(t.id) }} style={{ width: 22, height: 22 }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          {!showArchived && taskCompleted && isLastLane && status !== 'running' && (
                            <button
                              className="btn-icon"
                              title="归档任务"
                              aria-label="归档任务"
                              onClick={(e) => requestArchiveCard(e, t.id)}
                              style={{ width: 22, height: 22, color: 'var(--meta)' }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
                            </button>
                          )}
                          {showArchived && (
                            <button
                              className="btn-icon"
                              title="恢复到看板"
                              aria-label="恢复到看板"
                              onClick={(e) => handleUnarchive(e, t.id)}
                              style={{ width: 22, height: 22, color: 'var(--success)' }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                            </button>
                          )}
                          {status !== 'running' && (
                            <button className="btn-icon" title="删除" onClick={(e) => deleteCard(e, t.id)} style={{ width: 22, height: 22, marginLeft: 'auto', color: 'var(--danger)' }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Backdrop: click outside closes the new-task panel when unchanged */}
      {showNewPanel && (
        <div
          onClick={closeNewPanel}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
        />
      )}

      {/* ── New requirement panel (slide-in from right, fixed to viewport) ── */}
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: '50vw', minWidth: 420, background: 'var(--bg)',
        borderLeft: '1px solid var(--border-soft)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        transform: showNewPanel ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s ease',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>新建{createLane?.label || '需求'}任务</span>
          <button className="btn-icon" onClick={closeNewPanel} aria-label="关闭">✕</button>
        </div>
        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-soft)', padding: '0 16px', gap: 0, flexShrink: 0 }}>
          <button
            onClick={() => setActiveTab('content')}
            style={{
              padding: '10px 16px', fontSize: 13, fontWeight: activeTab === 'content' ? 600 : 400,
              border: 'none', borderBottom: activeTab === 'content' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              color: activeTab === 'content' ? 'var(--fg)' : 'var(--meta)',
              fontFamily: 'var(--font-body)',
            }}
          >任务内容</button>
          <button
            onClick={() => setActiveTab('review')}
            style={{
              padding: '10px 16px', fontSize: 13, fontWeight: activeTab === 'review' ? 600 : 400,
              border: 'none', borderBottom: activeTab === 'review' ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer',
              color: activeTab === 'review' ? 'var(--fg)' : 'var(--meta)',
              fontFamily: 'var(--font-body)',
            }}
          >审核配置</button>
        </div>

        {/* ── Tab: content ── */}
        {activeTab === 'content' && (
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {createLaneIndex > 0 && (
            <div style={{
              marginBottom: 10, padding: '11px 12px', borderRadius: 8,
              background: `color-mix(in oklab, ${createLane?.color || 'var(--accent)'}, transparent 91%)`,
              borderLeft: `3px solid ${createLane?.color || 'var(--accent)'}`,
              color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.55,
            }}>
              此任务将直接从“{createLane?.label}”阶段开始。
              之前的 {lanes.slice(0, createLaneIndex).map((lane) => `“${lane.label}”`).join('、')}
              阶段会标记为已跳过，不读取这些阶段的输出物。
            </div>
          )}
          <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)' }}>任务标题</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="输入标题..."
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              style={{ flex: 1 }}
            />
            <label
              title={`当前任务在“${createLane?.label || '当前阶段'}”创建后自动开始`}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <input
                type="checkbox"
                checked={newAutoStart}
                onChange={(event) => setNewAutoStart(event.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              自动开始
            </label>
          </div>
          <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)', marginTop: 8 }}>任务说明</label>
          <MarkdownEditor
            value={newDesc}
            onChange={setNewDesc}
            projectId={activeProject?.id}
            placeholder={`输入${createLane?.label || '当前阶段'}任务说明...（支持 Markdown，可直接粘贴图片）`}
          />
        </div>
        )}

        {/* ── Tab: review ── */}
        {activeTab === 'review' && (
        <div style={{ flex: 1, padding: '12px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Object.keys(reviewOverrides).length === 0 ? (
            <div style={{ color: 'var(--meta)', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
              当前流程暂无阶段审核配置
            </div>
          ) : (
            Object.entries(reviewOverrides).map(([key, cfg]) => {
              const lane = lanes.find((l) => l.key === key)
              const label = lane?.label || key
              const color = lane?.color || '#888'
              const laneIdx = lanes.findIndex((l) => l.key === key)
              const isUpstream = createLaneIndex >= 0 && laneIdx >= 0 && laneIdx < createLaneIndex
              return (
                <div key={key} style={{
                  padding: '10px 12px', borderRadius: 6,
                  background: isUpstream ? 'transparent' : `color-mix(in oklab, ${color}, transparent 96%)`,
                  border: `1px solid ${isUpstream ? 'var(--border)' : 'color-mix(in oklab, ' + color + ', transparent 85%)'}`,
                  display: 'flex', flexDirection: 'column', gap: 8,
                  opacity: isUpstream ? 0.4 : 1,
                }}>
                  {/* Row 1: stage name + controls */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: isUpstream ? 'var(--meta)' : 'var(--fg)' }}>{label}</span>
                      {isUpstream && (
                        <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', padding: '0 5px', borderRadius: 3, lineHeight: '18px' }}>已跳过</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--fg-2)', cursor: isUpstream ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                        <input
                          type="checkbox"
                          checked={cfg.auto}
                          disabled={isUpstream}
                          onChange={() => !isUpstream && setReviewOverrides(prev => ({ ...prev, [key]: { ...prev[key], auto: !prev[key].auto } }))}
                          style={{ accentColor: 'var(--accent)', width: 13, height: 13, margin: 0, flexShrink: 0 }}
                        />
                        自动审核
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <span style={{ color: 'var(--meta)', whiteSpace: 'nowrap' }}>重试</span>
                        <input
                          type="number"
                          min={1} max={5}
                          value={cfg.maxRetries}
                          disabled={isUpstream}
                          onChange={(e) => {
                            if (isUpstream) return
                            const v = Math.max(1, Math.min(5, Number(e.target.value) || 1))
                            setReviewOverrides(prev => ({ ...prev, [key]: { ...prev[key], maxRetries: v } }))
                          }}
                          style={{ width: 36, height: 22, fontSize: 11, padding: '0 4px', border: '1px solid var(--border)', borderRadius: 4, textAlign: 'center', background: isUpstream ? 'var(--surface)' : 'var(--bg)', color: isUpstream ? 'var(--meta)' : 'var(--fg)' }}
                        />
                      </div>
                    </div>
                  </div>
                  {/* Row 2: prompt editor */}
                  <MarkdownEditor
                    value={cfg.prompt}
                    onChange={(v) => { if (!isUpstream) setReviewOverrides(prev => ({ ...prev, [key]: { ...prev[key], prompt: v } })) }}
                    disabled={isUpstream}
                    projectId={activeProject?.id}
                    placeholder="审核提示词（留空使用默认）"
                    minHeight={28}
                    maxHeight={120}
                    ariaLabel={`${label}审核提示词`}
                  />
                </div>
              )
            })
          )}
        </div>
        )}

        {/* ── Error & Footer ── */}
        {createError && (
          <div style={{ padding: '8px 16px 0', fontSize: 13, color: 'var(--danger)' }}>{createError}</div>
        )}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={closeNewPanel}>取消</button>
          <button className="btn-primary" onClick={handleCreate}>创建</button>
        </div>
      </div>

      {/* ── Task detail slide-in panel from right ── */}
      {selectedTaskId && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSelectedTaskId(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
          />
          <TaskDetail
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
          />
        </>
      )}

      {/* ── Delete confirm dialog ── */}
      <ConfirmDialog
        open={confirmStartTaskId !== null}
        title="开始任务"
        message={`确定开始“${tasks.find((task) => task.id === confirmStartTaskId)?.title || '该任务'}”吗？流程将从当前阶段开始执行。`}
        confirmText="开始"
        onConfirm={handleStartConfirm}
        onCancel={() => setConfirmStartTaskId(null)}
      />

      <ConfirmDialog
        open={confirmDeleteTaskId !== null}
        title="删除任务"
        message="确定删除此任务？此操作不可撤销。"
        confirmText="删除"
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDeleteTaskId(null)}
      />

      <ConfirmDialog
        open={confirmArchiveTaskId !== null}
        title="归档任务"
        message={`确定归档“${tasks.find((task) => task.id === confirmArchiveTaskId)?.title || '该任务'}”吗？归档后任务将不再显示在看板中，可在“查看归档”中恢复。`}
        confirmText="归档"
        onConfirm={handleArchiveConfirm}
        onCancel={() => setConfirmArchiveTaskId(null)}
      />

      <ConfirmDialog
        open={confirmCloseNewTask}
        title="放弃新建任务"
        message="新建任务内容尚未保存，确定放弃并关闭？"
        confirmText="放弃"
        danger
        onConfirm={() => {
          setConfirmCloseNewTask(false)
          setShowNewPanel(false)
        }}
        onCancel={() => setConfirmCloseNewTask(false)}
      />

      <ConfirmDialog
        open={confirmCloseMemory}
        title="放弃记忆更改"
        message="记忆内容有未保存的更改，确定放弃并关闭？"
        confirmText="放弃更改"
        danger
        onConfirm={() => {
          setConfirmCloseMemory(false)
          setShowMemoryPanel(false)
        }}
        onCancel={() => setConfirmCloseMemory(false)}
      />

      {/* Backdrop: click outside closes the memory panel when unchanged */}
      {showMemoryPanel && (
        <div
          onClick={closeMemoryPanel}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 999 }}
        />
      )}

      {/* ── Memory editor panel (slide-in from right) ── */}
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: '50vw', minWidth: 420, background: 'var(--bg)',
        borderLeft: '1px solid var(--border-soft)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        transform: showMemoryPanel ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s ease',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            编辑记忆
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--meta)', fontWeight: 400 }}>.workstep/MEMORY.md</span>
          </span>
          <button className="btn-icon" onClick={closeMemoryPanel} aria-label="关闭">✕</button>
        </div>
        {memoryError && (
          <div style={{
            padding: '8px 16px', fontSize: 13, color: 'var(--danger)',
            background: 'color-mix(in oklab, var(--danger), transparent 90%)',
          }}>
            {memoryError}
          </div>
        )}
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {memoryLoading ? (
            <div style={{ color: 'var(--meta)', fontSize: 13 }}>加载中…</div>
          ) : (
            <MarkdownEditor
              value={memoryContent}
              onChange={setMemoryContent}
              projectId={activeProject?.id}
              ariaLabel="项目记忆"
            />
          )}
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          {memoryNotice && (
            <span style={{ color: 'var(--success)', fontSize: 13, marginRight: 'auto' }} role="status">
              {memoryNotice}
            </span>
          )}
          <button className="btn-ghost" onClick={closeMemoryPanel} style={{ fontSize: 13 }}>取消</button>
          <button
            className="btn-primary"
            onClick={() => void handleSaveMemory()}
            disabled={memoryLoading || memorySaving}
            style={{ fontSize: 13 }}
          >
            {memorySaving ? '保存中…' : '保存记忆'}
          </button>
        </div>
      </div>
    </>
  )
}
