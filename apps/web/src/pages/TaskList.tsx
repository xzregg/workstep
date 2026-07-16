import { useState, useEffect, useMemo } from 'react'
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

const cardStyle: React.CSSProperties = {
  background: 'var(--bg)', borderRadius: 'var(--radius-sm)',
  padding: '10px 12px', cursor: 'pointer',
  borderLeft: '3px solid var(--status-ready)',
  transition: 'box-shadow var(--motion-fast)',
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

/* ── Extract lanes from steps.json ── */
interface Lane {
  key: string
  label: string
  color: string
}

function getLanesFromSteps(steps: any): Lane[] {
  // New format: { nodes: [...] }
  if (steps?.nodes?.length) {
    return steps.nodes.map((n: any) => ({
      key: n.type || n.key || n.id,
      label: n.title || n.label || n.type,
      color: n.color || '#888',
    }))
  }
  // Legacy format: { steps: [...] }
  if (steps?.steps?.length) {
    return steps.steps.map((s: any) => ({
      key: s.key || s.id,
      label: s.label || s.name || s.key,
      color: s.color || '#888',
    }))
  }
  // Fallback
  return [{ key: 'do', label: '执行', color: '#0071e3' }]
}

export default function TaskList() {
  const navigate = useNavigate()
  const { tasks, loading, fetchTasks, createTask, setActiveTask } = useTaskStore()
  const activeProject = useProjectStore((s) => s.activeProject)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')

  // Re-fetch tasks when project changes
  useEffect(() => { fetchTasks() }, [fetchTasks, activeProject?.path])

  // Build lanes from project's steps.json
  const lanes = useMemo(() => {
    const base = getLanesFromSteps(activeProject?.steps)
    // Add a "done" lane at the end
    return [...base, { key: '__done__', label: '已完成', color: 'var(--success)' }]
  }, [activeProject?.steps])

  // Group tasks by current step
  // A task's current step = first step with status != 'passed', or '__done__' if all passed
  const getTaskLane = (task: any): string => {
    // If task has step info, use it
    if (task.current_step) return task.current_step
    // If task status indicates completion
    if (task.status === 'ready' && task.completed_steps) return '__done__'
    // Default: put in first lane
    return lanes[0]?.key || 'do'
  }

  const tasksByLane = useMemo(() => {
    const map: Record<string, any[]> = {}
    lanes.forEach((l) => { map[l.key] = [] })
    tasks.forEach((t: any) => {
      const lane = getTaskLane(t)
      if (map[lane]) {
        map[lane].push(t)
      } else {
        // Fallback to first lane
        if (lanes[0]) map[lanes[0].key]?.push(t)
      }
    })
    return map
  }, [tasks, lanes])

  const handleCreate = async () => {
    if (!title.trim() || !activeProject) return
    try {
      await createTask(title.trim(), activeProject.path)
      setTitle('')
      setShowCreate(false)
    } catch (e) {
      console.error('Create failed:', e)
    }
  }

  const handleSelectTask = (taskId: string) => {
    setActiveTask(taskId)
    navigate(`/tasks/${taskId}`)
  }

  return (
    <>
      {/* Topbar */}
      <div style={topbarStyle}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
        </svg>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>
          {activeProject?.name || '选择项目'}
        </span>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>任务看板</span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => navigate('/canvas')}>
          ⚙ 编辑流程
        </button>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          + 新任务
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

        {!loading && activeProject && lanes.map((lane) => {
          const laneTasks = tasksByLane[lane.key] || []
          return (
            <div key={lane.key} style={laneStyle}>
              <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: lane.color }} />
                  {lane.label}
                  <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--meta)' }}>
                    {laneTasks.length}
                  </span>
                </div>
              </div>
              <div style={laneBodyStyle}>
                {laneTasks.map((t: any) => (
                  <div
                    key={t.id}
                    onClick={() => handleSelectTask(t.id)}
                    style={{ ...cardStyle, borderLeftColor: lane.color }}
                    onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 2px 6px rgba(0,0,0,0.05)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none' }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.3, marginBottom: 3 }}>
                      {t.title}
                    </div>
                    {t.description && (
                      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4, marginBottom: 8 }}>
                        {t.description}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="status-badge" data-s={t.status}>{t.status}</span>
                      <span style={{ fontSize: 11, color: 'var(--meta)' }}>{t.engine}</span>
                    </div>
                  </div>
                ))}

                {lane.key === lanes[0]?.key && (
                  <button style={addCardStyle} onClick={() => setShowCreate(true)}>
                    + 添加任务
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Create task modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">创建任务</span>
              <button className="btn-icon" onClick={() => setShowCreate(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label>任务标题</label>
              <input
                placeholder="输入任务标题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => setShowCreate(false)}>取消</button>
              <button className="btn-primary" onClick={handleCreate}>创建</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
