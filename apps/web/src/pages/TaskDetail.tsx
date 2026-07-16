import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { useWebSocket } from '../hooks/useWebSocket'

export default function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  useWebSocket()

  const activeProject = useProjectStore((s) => s.activeProject)
  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] || [] : []))
  const content = useTaskStore((s) => (taskId ? s.content[taskId] || '' : ''))
  const runTask = useTaskStore((s) => s.runTask)
  const cancelTask = useTaskStore((s) => s.cancelTask)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)

  const projectPath = activeProject?.path || ''

  // Fetch tasks if not already loaded
  useEffect(() => {
    if (tasks.length === 0 && projectPath) fetchTasks(projectPath)
  }, [tasks.length, fetchTasks, projectPath])

  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [selectedStep, setSelectedStep] = useState('do')
  const contentEndRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const task = tasks.find((t) => t.id === taskId)

  useEffect(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [content, events])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  useEffect(() => {
    if (task) setRunning(task.status === 'running')
  }, [task?.status])

  const handleRun = async () => {
    if (!taskId || !prompt.trim()) return
    setRunning(true)
    try {
      await runTask(taskId, prompt.trim(), projectPath)
      setPrompt('')
    } catch {
      setRunning(false)
    }
  }

  const handleCancel = async () => {
    if (!taskId) return
    try {
      await cancelTask(taskId)
      setRunning(false)
    } catch { /* ignore */ }
  }

  if (!task) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--meta)' }}>
        任务未找到
        <br />
        <button className="btn-ghost" style={{ marginTop: 12 }} onClick={() => navigate(-1)}>← 返回</button>
      </div>
    )
  }

  const time = new Date(task.created_at * 1000).toLocaleString('zh-CN')

  // Separate events into chat messages
  const chatMessages = events.filter((e) =>
    e.type === 'text_delta' || e.type === 'tool_use' || e.type === 'tool_result' ||
    e.type === 'error' || e.type === 'usage'
  )

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* ── Header ── */}
      <div style={{
        padding: '18px 24px',
        borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'flex-start', gap: 16,
        background: 'var(--bg)',
      }}>
        <button className="btn-icon" onClick={() => navigate(-1)} style={{ marginTop: 2 }}>
          ←
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6, fontFamily: 'var(--font-display)' }}>
            {task.title}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="status-badge" data-s={task.status}>{task.status}</span>
            <span style={{
              fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 4,
              background: 'color-mix(in oklab, var(--accent), transparent 85%)',
              color: 'var(--accent)',
            }}>
              {task.engine}
            </span>
            <span style={{ fontSize: 12, color: 'var(--meta)' }}>{time}</span>
          </div>
        </div>
      </div>

      {/* ── Content split: left (info) + right (chat) ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Left: Progress + Events + Prompt ── */}
        <div style={{
          width: '45%', minWidth: 380,
          overflowY: 'auto', padding: '20px 24px',
          display: 'flex', flexDirection: 'column', gap: 24,
          borderRight: '1px solid var(--border-soft)',
        }}>
          {/* Progress timeline */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
              阶段进度
            </div>
            <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
              {['do'].map((step) => {
                const isActive = step === selectedStep
                const isDone = task.status === 'ready' && events.length > 0
                return (
                  <div
                    key={step}
                    onClick={() => setSelectedStep(step)}
                    style={{
                      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                      position: 'relative', paddingTop: 24, cursor: 'pointer',
                    }}
                  >
                    {/* Connector line */}
                    <div style={{
                      position: 'absolute', top: 10, left: 0, right: 0, height: 2,
                      background: isDone ? 'var(--success)' : 'var(--border)',
                    }} />
                    {/* Dot */}
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--bg)',
                      border: `2px solid ${isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--meta)'}`,
                      position: 'relative', zIndex: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: isActive ? '0 0 0 4px color-mix(in oklab, var(--accent), transparent 70%)' : 'none',
                    }}>
                      {isDone && <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>✓</span>}
                    </div>
                    <span style={{
                      fontSize: 11, marginTop: 8,
                      color: isDone ? 'var(--success)' : isActive ? 'var(--accent)' : 'var(--muted)',
                      fontWeight: isActive ? 600 : 400,
                    }}>
                      执行
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Event log */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
              执行日志
            </div>
            <div style={{
              background: '#1e1e1e', color: '#d4d4d4',
              borderRadius: 'var(--radius-sm)', padding: 16,
              fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              minHeight: 200, maxHeight: 400, overflowY: 'auto',
            }}>
              {events.map((ev, i) => {
                if (ev.type === 'text_delta' || ev.type === 'thinking_delta') return null
                if (ev.type === 'status') {
                  return <div key={i} style={{ color: '#888', fontSize: 12 }}>[{String(ev.data.status)}]</div>
                }
                if (ev.type === 'tool_use') {
                  return (
                    <div key={i} style={{ background: '#2d2d2d', padding: '4px 8px', borderRadius: 4, margin: '4px 0' }}>
                      🔧 {String(ev.data.name)}
                      {ev.data.input ? (
                        <span style={{ color: '#888', marginLeft: 8 }}>
                          {JSON.stringify(ev.data.input).slice(0, 80)}
                        </span>
                      ) : null}
                    </div>
                  )
                }
                if (ev.type === 'tool_result') {
                  return (
                    <div key={i} style={{ background: '#1a3a1a', padding: '4px 8px', borderRadius: 4, margin: '4px 0', color: '#8f8' }}>
                      ✓ result{ev.data.is_error ? ' (error)' : ''}
                    </div>
                  )
                }
                if (ev.type === 'usage') {
                  return (
                    <div key={i} style={{ color: '#888', fontSize: 11, marginTop: 8 }}>
                      tokens: {String(ev.data.input_tokens)}in / {String(ev.data.output_tokens)}out
                    </div>
                  )
                }
                if (ev.type === 'error') {
                  return (
                    <div key={i} style={{ color: '#f44', background: '#3a1a1a', padding: '4px 8px', borderRadius: 4 }}>
                      ❌ {String(ev.data.message)}
                    </div>
                  )
                }
                return null
              })}
              {content && <div style={{ marginTop: 8, color: '#e0e0e0' }}>{content}</div>}
              <div ref={contentEndRef} />
            </div>
          </div>
        </div>

        {/* ── Right: Chat panel ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          {/* Chat header */}
          <div style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border-soft)',
            background: 'var(--bg)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>对话</span>
            <span style={{
              fontSize: 11, color: 'var(--muted)',
              background: 'var(--surface)', border: '1px solid var(--border-soft)',
              padding: '2px 8px', borderRadius: 4,
            }}>
              {task.engine}
            </span>
          </div>

          {/* Chat messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {chatMessages.length === 0 && !running && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 40, fontSize: 13 }}>
                输入 prompt 开始执行任务
              </div>
            )}

            {/* Render accumulated text as assistant bubble */}
            {content && (
              <div style={{ display: 'flex', gap: 12, maxWidth: '85%' }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'var(--fg)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 600, flexShrink: 0,
                }}>
                  AI
                </div>
                <div>
                  <div style={{
                    padding: '10px 14px', borderRadius: 12, borderBottomLeftRadius: 4,
                    background: 'var(--bg)', border: '1px solid var(--border-soft)',
                    fontSize: 13, lineHeight: 1.5,
                  }}>
                    {content}
                  </div>
                </div>
              </div>
            )}

            {/* Tool use events as system messages */}
            {events.filter((e) => e.type === 'tool_use').map((ev, i) => (
              <div key={`tool-${i}`} style={{
                display: 'flex', gap: 12, maxWidth: '85%',
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'var(--warn)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 600, flexShrink: 0,
                }}>
                  !
                </div>
                <div style={{
                  padding: '8px 14px', borderRadius: 12,
                  background: 'color-mix(in oklab, var(--warn), transparent 90%)',
                  border: '1px dashed var(--warn)',
                  fontSize: 13, lineHeight: 1.5,
                }}>
                  🔧 <strong>{String(ev.data.name)}</strong>
                  {ev.data.input ? (
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                      {JSON.stringify(ev.data.input).slice(0, 120)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border-soft)',
            background: 'var(--bg)',
            display: 'flex', gap: 8, alignItems: 'flex-end',
          }}>
            <textarea
              placeholder={running ? '任务运行中...' : '输入 prompt (Enter 发送, Shift+Enter 换行)'}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !running) {
                  e.preventDefault()
                  handleRun()
                }
              }}
              disabled={running}
              style={{
                flex: 1, height: 44, minHeight: 44, maxHeight: 120,
                padding: '10px 14px', resize: 'none',
                borderRadius: 12, fontSize: 13, lineHeight: 1.5,
              }}
            />
            {running ? (
              <button
                onClick={handleCancel}
                style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: 'var(--danger)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', flexShrink: 0, cursor: 'pointer', fontSize: 16,
                }}
              >
                ■
              </button>
            ) : (
              <button
                onClick={handleRun}
                style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: 'var(--accent)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', flexShrink: 0, cursor: 'pointer', fontSize: 16,
                }}
              >
                ▶
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
