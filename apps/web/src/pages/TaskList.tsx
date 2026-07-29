import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { fsApi, type DirectoryOpener } from '../api/client'
import TaskDetail from './TaskDetail'
import ConfirmDialog from '../components/ConfirmDialog'

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

const addCardStyle: React.CSSProperties = {
  border: '1.5px dashed var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: 8, textAlign: 'center',
  cursor: 'pointer', color: 'var(--meta)',
  fontSize: 12, background: 'transparent',
  width: '100%', fontFamily: 'var(--font-body)',
  marginTop: 4,
}

/* ── Status machine ── */
const STATUS_LABELS: Record<string, string> = {
  ready: '预备中', running: '开始', paused: '暂停', stopped: '停止',
  reviewing: '审核中', awaiting_review: '等待审核',
  retrying: '自动重跑', rejected: '审核未通过',
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
  const { tasks, loading, fetchTasks, createTask, deleteTask, setActiveTask } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [showNewPanel, setShowNewPanel] = useState(false)
  const [createStartStepKey, setCreateStartStepKey] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [dragOverLane, setDragOverLane] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
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
    fetchTasks(activeProject.id)
  }, [fetchTasks, activeProject?.id])

  // Reset local state when project changes
  useEffect(() => {
    setCardLanes({})
    setShowNewPanel(false)
    setCreateStartStepKey(null)
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

  const openNewPanel = (stepKey?: string) => {
    setCreateStartStepKey(stepKey || lanes[0]?.key || null)
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

  const tasksByLane = useMemo(() => {
    const map: Record<string, typeof tasks> = {}
    lanes.forEach((l) => { map[l.key] = [] })
    tasks.forEach((t: any) => {
      const lane = getCardLane(t.id)
      if (map[lane]) map[lane].push(t)
      else if (lanes[0]) map[lanes[0].key]?.push(t)
    })
    return map
  }, [tasks, lanes, getCardLane])

  const handleCreate = async () => {
    if (!newTitle.trim() || !activeProject) return
    try {
      await createTask(
        newTitle.trim(),
        activeProject.path,
        activeProject.id,
        newDesc.trim() || undefined,
        createLane?.key,
      )
      setNewTitle('')
      setNewDesc('')
      setShowNewPanel(false)
    } catch (e) { console.error('Create failed:', e) }
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

  const selectDirectoryOpener = (opener: DirectoryOpener) => {
    setSelectedOpener(opener.id)
    localStorage.setItem('workstep-directory-opener', opener.id)
    setShowOpenerMenu(false)
    void openProjectDirectory(opener.id)
  }

  const advanceCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    const curLane = getCardLane(taskId)
    const idx = lanes.findIndex((l) => l.key === curLane)
    if (idx < lanes.length - 1) {
      setCardLanes((prev) => ({ ...prev, [taskId]: lanes[idx + 1].key }))
    }
  }

  const retreatCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    const curLane = getCardLane(taskId)
    const idx = lanes.findIndex((l) => l.key === curLane)
    if (idx > 0) {
      setCardLanes((prev) => ({ ...prev, [taskId]: lanes[idx - 1].key }))
    }
  }

  const deleteCard = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    setConfirmDeleteTaskId(taskId)
  }

  const handleDeleteConfirm = async () => {
    if (confirmDeleteTaskId && activeProject) {
      await deleteTask(confirmDeleteTaskId, activeProject.id)
      setCardLanes((prev) => { const next = { ...prev }; delete next[confirmDeleteTaskId]; return next })
      setConfirmDeleteTaskId(null)
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
        <button className="btn-ghost" onClick={() => navigate(`/canvas?project=${encodeURIComponent(activeProject?.name || '')}`)} style={{ fontSize: 13, gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          阶段编辑
        </button>
        <button className="btn-primary" onClick={() => openNewPanel()} style={{ fontSize: 13, gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建
        </button>
        <div style={{ flex: 1 }} />
        {directoryNotice && (
          <span
            role="status"
            style={{
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', color: 'var(--meta)', fontSize: 12,
            }}
            title={directoryNotice}
          >
            {directoryNotice}
          </span>
        )}
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
                    color: 'var(--fg)', fontSize: 14,
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
              <div style={{ fontSize: 14 }}>请在左侧选择一个项目</div>
            </div>
          </div>
        )}

        {!loading && activeProject && lanes.map((lane, li) => {
          const laneTasks = tasksByLane[lane.key] || []
          return (
            <div key={lane.key} style={laneStyle}>
              <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: lane.color }} />
                  {lane.label}
                  <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--meta)' }}>({laneTasks.length})</span>
                </div>
                <button className="btn-icon" title={`新建${lane.label}任务`} onClick={() => openNewPanel(lane.key)} style={{ width: 24, height: 24 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
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
                  const stageStatus = ['reviewing', 'awaiting_review', 'retrying', 'rejected']
                    .find((candidate) =>
                      (t.steps || []).some((step: any) => step.status === candidate)
                    )
                  const displayStatus = stageStatus || status
                  const statusColor = STATUS_COLORS[displayStatus] || 'var(--status-ready)'
                  return (
                    <div
                      key={t.id}
                      data-task-status={status}
                      draggable
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
                          {STATUS_LABELS[displayStatus] || displayStatus}
                        </span>
                      </div>
                      {t.description && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4, marginBottom: 8 }}>{t.description}</div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{
                          fontSize: 11, padding: '2px 7px', borderRadius: 'var(--radius-pill)', fontWeight: 500,
                          background: `color-mix(in oklab, ${lane.color}, transparent 90%)`,
                          color: lane.color,
                        }}>
                          {lane.label}
                        </span>
                        <div className="card-actions" style={{ display: 'flex', gap: 2, opacity: 0, transition: 'opacity var(--motion-fast)' }}>
                          {li < lanes.length - 1 && (
                            <button className="btn-icon" title="推进" onClick={(e) => advanceCard(e, t.id)} style={{ width: 22, height: 22, color: 'var(--success)' }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                            </button>
                          )}
                          {li > 0 && (
                            <button className="btn-icon" title="回退" onClick={(e) => retreatCard(e, t.id)} style={{ width: 22, height: 22 }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                            </button>
                          )}
                          <button className="btn-icon" title="编辑" onClick={(e) => { e.stopPropagation(); handleSelectTask(t.id) }} style={{ width: 22, height: 22 }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          <button className="btn-icon" title="删除" onClick={(e) => deleteCard(e, t.id)} style={{ width: 22, height: 22, color: 'var(--danger)' }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
                <button style={addCardStyle} onClick={() => openNewPanel(lane.key)}>+ 添加{lane.label}任务</button>
              </div>
            </div>
          )
        })}
      </div>

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
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>新建{createLane?.label || '需求'}任务</span>
          <button className="btn-icon" onClick={() => setShowNewPanel(false)}>✕</button>
        </div>
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {createLaneIndex > 0 && (
            <div style={{
              marginBottom: 10, padding: '11px 12px', borderRadius: 8,
              background: `color-mix(in oklab, ${createLane?.color || 'var(--accent)'}, transparent 91%)`,
              borderLeft: `3px solid ${createLane?.color || 'var(--accent)'}`,
              color: 'var(--fg-2)', fontSize: 12, lineHeight: 1.55,
            }}>
              此任务将直接从“{createLane?.label}”阶段开始。
              之前的 {lanes.slice(0, createLaneIndex).map((lane) => `“${lane.label}”`).join('、')}
              阶段会标记为已跳过，不读取这些阶段的输出物。
            </div>
          )}
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>任务标题</label>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="输入标题..."
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginTop: 8 }}>任务说明</label>
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder={`输入${createLane?.label || '当前阶段'}任务说明...`}
            style={{ minHeight: 160, resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }}
          />
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={() => setShowNewPanel(false)}>取消</button>
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
        open={confirmDeleteTaskId !== null}
        title="删除任务"
        message="确定删除此任务？此操作不可撤销。"
        confirmText="删除"
        danger
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirmDeleteTaskId(null)}
      />
    </>
  )
}
