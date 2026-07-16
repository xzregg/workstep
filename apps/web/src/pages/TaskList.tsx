import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'

/* ── Styles ── */
const topbarStyle: React.CSSProperties = {
  height: 48, background: 'var(--bg)',
  borderBottom: '1px solid var(--border-soft)',
  display: 'flex', alignItems: 'center',
  padding: '0 20px', gap: 12, flexShrink: 0,
}

const kanbanStyle: React.CSSProperties = {
  flex: 1, display: 'flex', gap: 0,
  overflowX: 'auto', padding: '16px 16px 16px 0',
  minWidth: 0,
}

const laneStyle: React.CSSProperties = {
  minWidth: 260, maxWidth: 320, flex: 1,
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
const STATUS_CYCLE = ['ready', 'running', 'paused', 'stopped'] as const
const STATUS_LABELS: Record<string, string> = {
  ready: '预备中', running: '开始', paused: '暂停', stopped: '停止',
}

/* ── Extract lanes from steps.json ── */
interface Lane { key: string; label: string; color: string }

function getLanesFromSteps(steps: any): Lane[] {
  if (steps?.nodes?.length) {
    return steps.nodes.map((n: any) => ({
      key: n.type || n.key || String(n.id),
      label: n.title || n.label || n.type,
      color: n.color || '#888',
    }))
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

export default function TaskList() {
  const navigate = useNavigate()
  const { tasks, loading, fetchTasks, createTask, setActiveTask } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [showNewPanel, setShowNewPanel] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [dragOverLane, setDragOverLane] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  // Local card state: lane assignment + status (until backend supports it)
  const [cardLanes, setCardLanes] = useState<Record<string, string>>({})
  const [cardStatuses, setCardStatuses] = useState<Record<string, string>>({})

  useEffect(() => { fetchTasks() }, [fetchTasks, activeProject?.path])

  // Reset local state when project changes
  useEffect(() => {
    setCardLanes({})
    setCardStatuses({})
  }, [activeProject?.path])

  const lanes = useMemo(() => getLanesFromSteps(activeProject?.steps), [activeProject?.steps])

  // Assign default lane (first lane) to new tasks
  const getCardLane = useCallback((taskId: string): string => {
    return cardLanes[taskId] || lanes[0]?.key || 'do'
  }, [cardLanes, lanes])

  const getCardStatus = useCallback((taskId: string): string => {
    return cardStatuses[taskId] || 'ready'
  }, [cardStatuses])

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
      await createTask(newTitle.trim(), activeProject.path)
      setNewTitle('')
      setNewDesc('')
      setShowNewPanel(false)
    } catch (e) { console.error('Create failed:', e) }
  }

  const handleSelectTask = (taskId: string) => {
    setActiveTask(taskId)
    navigate(`/tasks/${taskId}`)
  }

  const cycleStatus = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation()
    const cur = getCardStatus(taskId)
    const idx = STATUS_CYCLE.indexOf(cur as any)
    const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
    setCardStatuses((prev) => ({ ...prev, [taskId]: next }))
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
    if (confirm('确定删除？')) {
      // TODO: call backend delete API
      setCardLanes((prev) => { const next = { ...prev }; delete next[taskId]; return next })
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative', minWidth: 0 }}>
      {/* Topbar */}
      <div style={topbarStyle}>
        <button className="btn-ghost" onClick={() => navigate('/canvas')} style={{ fontSize: 13, gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          阶段编辑
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn-primary" onClick={() => setShowNewPanel(true)} style={{ fontSize: 13, gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建
        </button>
      </div>

      {/* Kanban board */}
      <div style={kanbanStyle}>
        {loading && <div style={{ padding: 40, color: 'var(--meta)' }}>加载中...</div>}

        {!loading && !activeProject && (
          <div style={{ padding: 40, color: 'var(--meta)', textAlign: 'center', width: '100%' }}>
            请在左侧选择一个项目
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
                <button className="btn-icon" title="添加" onClick={() => setShowNewPanel(true)} style={{ width: 24, height: 24 }}>
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
                  const status = getCardStatus(t.id)
                  return (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => onDragStart(e, t.id)}
                      onDragEnd={onDragEnd}
                      onClick={() => handleSelectTask(t.id)}
                      style={{
                        background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
                        padding: '10px 12px', cursor: 'grab',
                        borderLeft: `3px solid ${lane.color}`,
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
                          data-s={status}
                          onClick={(e) => cycleStatus(e, t.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          {STATUS_LABELS[status] || status}
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
                <button style={addCardStyle} onClick={() => setShowNewPanel(true)}>+ 添加</button>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── New requirement panel (slide-in from right, fixed to viewport) ── */}
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0,
        width: 360, background: 'var(--bg)',
        borderLeft: '1px solid var(--border-soft)',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        transform: showNewPanel ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.3s ease',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>新建需求</span>
          <button className="btn-icon" onClick={() => setShowNewPanel(false)}>✕</button>
        </div>
        <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}>标题</label>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="输入标题..."
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)', marginTop: 8 }}>需求内容</label>
          <textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="输入需求内容..."
            style={{ minHeight: 160, resize: 'vertical', fontFamily: 'var(--font-body)', fontSize: 13 }}
          />
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn-ghost" onClick={() => setShowNewPanel(false)}>取消</button>
          <button className="btn-primary" onClick={handleCreate}>创建</button>
        </div>
      </div>
    </div>
  )
}
