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

  // Auto-scroll to bottom when content updates
  useEffect(() => {
    contentEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [content, events])

  // Sync running state with task status
  useEffect(() => {
    if (task) setRunning(task.status === 'running')
  }, [task?.status])

  const handleRun = async () => {
    if (!taskId || !prompt.trim()) return
    setRunning(true)
    try {
      await runTask(taskId, prompt.trim())
      setPrompt('')
    } catch (e) {
      console.error('Run failed:', e)
      setRunning(false)
    }
  }

  const handleCancel = async () => {
    if (!taskId) return
    try {
      await cancelTask(taskId)
      setRunning(false)
    } catch (e) {
      console.error('Cancel failed:', e)
    }
  }

  if (!task) {
    return (
      <div style={{ maxWidth: 800, margin: '40px auto', padding: 20 }}>
        <p>任务未找到</p>
        <button onClick={() => navigate(-1)}>返回</button>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 20, height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <button onClick={() => navigate(-1)} style={{ marginRight: 8 }}>←</button>
          <strong>{task.title}</strong>
          <span style={{ marginLeft: 8, fontSize: 12, color: task.status === 'running' ? '#2196f3' : '#888' }}>
            {task.status}
          </span>
        </div>
      </div>

      {/* Event log */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        background: '#1e1e1e',
        color: '#d4d4d4',
        borderRadius: 8,
        padding: 16,
        fontFamily: 'monospace',
        fontSize: 13,
        lineHeight: 1.6,
        marginBottom: 16,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {/* Render events */}
        {events.map((ev, i) => {
          if (ev.type === 'text_delta') return null // rendered in content block below
          if (ev.type === 'thinking_delta') return null
          if (ev.type === 'status') {
            return (
              <div key={i} style={{ color: '#888', fontSize: 12 }}>
                [{String(ev.data.status)}]
              </div>
            )
          }
          if (ev.type === 'tool_use') {
            return (
              <div key={i} style={{ background: '#2d2d2d', padding: '4px 8px', borderRadius: 4, margin: '4px 0' }}>
                🔧 {ev.data.name as string}
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
                tokens: {ev.data.input_tokens as number}in / {ev.data.output_tokens as number}out
              </div>
            )
          }
          if (ev.type === 'error') {
            return (
              <div key={i} style={{ color: '#f44', background: '#3a1a1a', padding: '4px 8px', borderRadius: 4 }}>
                ❌ {ev.data.message as string}
              </div>
            )
          }
          return null
        })}

        {/* Accumulated text content */}
        {content && <div style={{ marginTop: 8 }}>{content}</div>}

        <div ref={contentEndRef} />
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          placeholder={running ? '任务运行中...' : '输入 prompt'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !running && handleRun()}
          disabled={running}
          style={{ flex: 1, padding: '10px 12px', fontSize: 14, borderRadius: 8, border: '1px solid #ddd' }}
        />
        {running ? (
          <button onClick={handleCancel} style={{ padding: '10px 20px', fontSize: 14, background: '#f44336', color: '#fff', border: 'none', borderRadius: 8 }}>
            停止
          </button>
        ) : (
          <button onClick={handleRun} style={{ padding: '10px 20px', fontSize: 14, background: '#4caf50', color: '#fff', border: 'none', borderRadius: 8 }}>
            运行
          </button>
        )}
      </div>
    </div>
  )
}
