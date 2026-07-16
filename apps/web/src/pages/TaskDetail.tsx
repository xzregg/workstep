import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTaskStore } from '../stores/taskStore'
import { useWebSocket } from '../hooks/useWebSocket'

export default function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  useWebSocket()

  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] || [] : []))
  const content = useTaskStore((s) => (taskId ? s.content[taskId] || '' : ''))
  const runTask = useTaskStore((s) => s.runTask)
  const cancelTask = useTaskStore((s) => s.cancelTask)

  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const contentEndRef = useRef<HTMLDivElement>(null)
  const task = tasks.find((t) => t.id === taskId)

  useEffect(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [content, events])

  useEffect(() => {
    if (task) setRunning(task.status === 'running')
  }, [task?.status])

  const handleRun = async () => {
    if (!taskId || !prompt.trim()) return
    setRunning(true)
    try {
      await runTask(taskId, prompt.trim())
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

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
      {/* Header */}
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
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{task.title}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="status-badge" data-s={task.status}>{task.status}</span>
            <span style={{ fontSize: 12, color: 'var(--meta)' }}>{time}</span>
            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4,
              background: 'color-mix(in oklab, var(--accent), transparent 85%)',
              color: 'var(--accent)',
            }}>
              {task.engine}
            </span>
          </div>
        </div>
      </div>

      {/* Content: left (events log) + right (chat) */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Event log */}
        <div style={{
          width: '50%', minWidth: 400,
          overflowY: 'auto', padding: 16,
          borderRight: '1px solid var(--border-soft)',
        }}>
          <div style={{
            fontSize: 13, fontWeight: 600, textTransform: 'uppercase' as const,
            letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 12,
          }}>
            执行日志
          </div>

          <div style={{
            background: '#1e1e1e', color: '#d4d4d4',
            borderRadius: 'var(--radius-sm)', padding: 16,
            fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            minHeight: 200,
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

        {/* Right: Chat input */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-soft)',
            fontSize: 13, fontWeight: 600,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.5px', color: 'var(--muted)',
            background: 'var(--bg)',
          }}>
            对话
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
            {events.length === 0 && !running && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 40, fontSize: 13 }}>
                输入 prompt 开始执行任务
              </div>
            )}
            {/* Render text deltas as chat bubbles */}
            {content && (
              <div style={{
                background: 'var(--bg)', border: '1px solid var(--border-soft)',
                borderRadius: 'var(--radius-sm)', borderBottomLeftRadius: 4,
                padding: '10px 14px', fontSize: 13, lineHeight: 1.5,
                marginBottom: 8,
              }}>
                {content}
              </div>
            )}
          </div>

          {/* Input area */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border-soft)',
            background: 'var(--bg)',
            display: 'flex', gap: 8,
          }}>
            <textarea
              placeholder={running ? '任务运行中...' : '输入 prompt (Enter 发送)'}
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
                flex: 1, height: 40, minHeight: 40, maxHeight: 120,
                padding: '8px 12px', resize: 'none',
              }}
            />
            {running ? (
              <button
                onClick={handleCancel}
                style={{
                  width: 40, height: 40, borderRadius: '50%',
                  background: 'var(--danger)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', flexShrink: 0,
                }}
              >
                ■
              </button>
            ) : (
              <button
                onClick={handleRun}
                className="btn-primary"
                style={{
                  width: 40, height: 40, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, padding: 0,
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
