import { useState, useEffect, useRef, useMemo } from 'react'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { useWebSocket } from '../hooks/useWebSocket'
import { taskApi } from '../api/client'

const EMPTY_EVENTS: any[] = []

const STATUS_LABELS: Record<string, string> = {
  ready: '预备中', running: '开始', paused: '暂停', stopped: '停止',
}

interface TaskDetailProps {
  taskId: string
  onClose: () => void
}

export default function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  useWebSocket()

  const activeProject = useProjectStore((s) => s.activeProject)
  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] : undefined) ?? EMPTY_EVENTS)
  const content = useTaskStore((s) => (taskId ? s.content[taskId] : '') ?? '')
  const runTask = useTaskStore((s) => s.runTask)
  const cancelTask = useTaskStore((s) => s.cancelTask)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)

  const projectId = activeProject?.id || ''
  const task = tasks.find((t) => t.id === taskId)
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [selectedStage, setSelectedStage] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [historyMessages, setHistoryMessages] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Load historical messages when panel opens
  useEffect(() => {
    if (!taskId || !projectId) return
    setHistoryLoading(true)
    taskApi.history(taskId, projectId, 50, 0)
      .then((res) => setHistoryMessages(res.messages || []))
      .catch(() => setHistoryMessages([]))
      .finally(() => setHistoryLoading(false))
  }, [taskId, projectId])

  // Fetch tasks if not already loaded
  useEffect(() => {
    if (tasks.length === 0 && projectId) fetchTasks(projectId)
  }, [tasks.length, fetchTasks, projectId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events, content])

  useEffect(() => {
    if (task) setRunning(task.status === 'running')
  }, [task?.status])

  // Get stages from project steps
  const stages = useMemo(() => {
    const steps = activeProject?.steps
    if (steps?.nodes?.length) return steps.nodes.map((n: any) => ({ key: n.type || n.key, label: n.title || n.label, color: n.color || '#888', prompt: n.prompt || '', inputs: (n.inputs || []).map((i: any) => ({ name: i.name, type: i.type })), outputs: (n.outputs || []).map((o: any) => ({ name: o.name, type: o.type })) }))
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({ key: s.key || s.id, label: s.label || s.name, color: s.color || '#888', prompt: s.prompt || '', inputs: (s.inputs || []).map((i: any) => ({ name: i.name || i, type: i.type || 'any' })), outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'any' })) }))
    return [{ key: 'do', label: '执行', color: '#0071e3', prompt: '', inputs: [], outputs: [] }]
  }, [activeProject?.steps])

  const handleRun = async () => {
    if (!taskId || !prompt.trim() || !projectId) return
    setRunning(true)
    try {
      await runTask(taskId, prompt.trim(), projectId)
      setPrompt('')
    } catch { setRunning(false) }
  }

  const handleCancel = async () => {
    if (!taskId) return
    try { await cancelTask(taskId); setRunning(false) } catch {}
  }

  if (!task) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--meta)' }}>
        任务未找到
        <br />
        <button className="btn-ghost" style={{ marginTop: 12 }} onClick={onClose}>← 返回</button>
      </div>
    )
  }

  const currentStage = stages[selectedStage] || stages[0]
  const time = new Date(task.created_at * 1000).toLocaleString('zh-CN')

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0,
      width: '85vw', maxWidth: 1200, minWidth: 800,
      background: 'var(--bg)',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.12)',
      display: 'flex', flexDirection: 'column',
      zIndex: 1000, height: '100vh',
      animation: 'slideInRight 0.3s ease',
    }}>
      {/* ── Header ── */}
      <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 }}>
        <button className="btn-icon" onClick={onClose} style={{ marginTop: 2 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{task.title}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 4, lineHeight: 1.6,
              background: `color-mix(in oklab, var(--status-${task.status === 'ready' ? 'ready' : task.status}), transparent 85%)`,
              color: `var(--status-${task.status === 'ready' ? 'ready' : task.status})`,
            }}>
              {STATUS_LABELS[task.status] || task.status}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 4,
              background: 'color-mix(in oklab, var(--accent), transparent 85%)', color: 'var(--accent)',
            }}>
              {currentStage.label} 阶段
            </span>
            <span style={{ fontSize: 12, color: 'var(--meta)' }}>{time}</span>
          </div>
        </div>
      </div>

      {/* ── Content split ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* ── Left panel ── */}
        <div style={{ width: '45%', minWidth: 380, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 24, borderRight: '1px solid var(--border-soft)' }}>

          {/* Progress timeline */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>进度</div>
            <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
              {stages.map((stage: any, i: number) => {
                const isCurrentActive = (task.status === 'running' || task.status === 'ready') && i === 0
                const isSelected = i === selectedStage
                return (
                  <div
                    key={stage.key}
                    onClick={() => setSelectedStage(i)}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', paddingTop: 24, cursor: 'pointer' }}
                  >
                    {/* Connector line */}
                    <div style={{
                      position: 'absolute', top: 10,
                      left: i === 0 ? '50%' : 0, right: i === stages.length - 1 ? '50%' : 0,
                      height: 2, background: isCurrentActive ? 'var(--accent)' : 'var(--border)',
                    }} />
                    {/* Dot */}
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: isCurrentActive ? 'var(--accent)' : 'var(--bg)',
                      border: `2px solid ${isCurrentActive ? 'var(--accent)' : 'var(--border)'}`,
                      position: 'relative', zIndex: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: isCurrentActive ? '0 0 0 4px color-mix(in oklab, var(--accent), transparent 70%)' : 'none',
                    }} />
                    <span style={{
                      fontSize: 11, marginTop: 8, textAlign: 'center', whiteSpace: 'nowrap',
                      color: isCurrentActive ? 'var(--accent)' : 'var(--muted)',
                      fontWeight: isSelected ? 600 : isCurrentActive ? 500 : 400,
                      textDecoration: isSelected ? 'underline' : 'none',
                      textUnderlineOffset: '3px',
                    }}>
                      {stage.label}
                    </span>
                    {/* Time info for active stage */}
                    {isCurrentActive && (
                      <div style={{ fontSize: 10, color: 'var(--meta)', marginTop: 4, textAlign: 'center', lineHeight: 1.5 }}>
                        <div>开始: {new Date(task.created_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
                        {task.updated_at !== task.created_at && (
                          <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>
                            {Math.round((task.updated_at - task.created_at) / 60)}分钟
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* I/O section — matching card-detail.html layout */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>
              阶段输入输出 — {currentStage.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--meta)' }}>→</span> 输入
                </div>
                {(() => {
                  const isStageDone = selectedStage < (task.status === 'running' ? selectedStage : 0)
                  const nextStageIdx = selectedStage + 1
                  const nextStage = nextStageIdx < stages.length ? stages[nextStageIdx] : null
                  const nextInputs = nextStage ? (nextStage.inputs || []) : []
                  // Outputs are attached to the FIRST input only (matching card-detail.html)
                  const stageOutputs = currentStage.outputs || (currentStage.inputs || [])[0]?.outputs || []

                  return (currentStage.inputs || []).map((inp: any, inpIdx: number) => {
                    const subOutputs = inpIdx === 0 ? stageOutputs : []
                    return (
                      <div key={inpIdx} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {/* Input item */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border-soft)' }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                          <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{inp.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 4px', borderRadius: 3 }}>{inp.type}</span>
                        </div>
                        {/* Sub-outputs (only on first input) */}
                        {subOutputs.map((out: any, outIdx: number) => {
                          const nextInput = nextInputs[outIdx]
                          const statusDone = isStageDone
                          return (
                            <div key={outIdx} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 18, padding: '4px 8px' }}>
                              <span style={{ color: 'var(--meta)', fontSize: 11 }}>↳</span>
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
                              <span style={{ fontSize: 12, flex: 1 }}>{out.name}</span>
                              <span style={{ fontSize: 10, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 3px', borderRadius: 2 }}>{out.type}</span>
                              <span style={{
                                fontSize: 9, fontWeight: 500, padding: '1px 5px', borderRadius: 3,
                                background: statusDone ? 'color-mix(in oklab, var(--success), transparent 85%)' : 'var(--surface)',
                                color: statusDone ? 'var(--success)' : 'var(--meta)',
                                border: statusDone ? 'none' : '1px solid var(--border-soft)',
                              }}>
                                {statusDone ? '完成' : '待生成'}
                              </span>
                              {nextInput && (
                                <span style={{ fontSize: 10, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 2 }}>
                                  <span style={{ color: 'var(--meta)', fontSize: 9 }}>→</span> {nextStage?.label}: {nextInput.name}
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          </div>

          {/* Prompt section */}
          {currentStage.prompt && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>阶段提示词</div>
              <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-sm)', padding: '14px 16px' }}>
                <div style={{ fontSize: 13, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{currentStage.prompt}</div>
              </div>
            </div>
          )}
        </div>

        {/* ── Right panel: Chat ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          {/* Chat header */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>对话记录</span>
            <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '2px 8px', borderRadius: 4 }}>{task.engine || 'claude'}</span>
          </div>

          {/* Chat messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {historyLoading && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 20, fontSize: 13 }}>加载中...</div>
            )}

            {!historyLoading && historyMessages.length === 0 && events.length === 0 && !content && !running && (
              <div style={{ textAlign: 'center', color: 'var(--meta)', padding: 40, fontSize: 13 }}>
                输入补充说明或追问开始对话
              </div>
            )}

            {/* Historical messages */}
            {historyMessages.map((msg: any, i: number) => {
              const isUser = msg.role === 'user'
              const isSystem = msg.role === 'system'
              const avatarText = isUser ? '我' : isSystem ? '!' : 'AI'
              const avatarBg = isUser ? 'var(--accent)' : isSystem ? 'var(--warn)' : 'var(--fg)'
              const bubbleStyle = isUser
                ? { background: 'var(--accent)', color: '#fff', borderBottomRightRadius: 4 }
                : isSystem
                  ? { background: 'color-mix(in oklab, var(--warn), transparent 90%)', color: 'var(--fg-2)', border: '1px dashed var(--border)', fontSize: 12 }
                  : { background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-soft)', borderBottomLeftRadius: 4 }

              return (
                <div key={`hist-${i}`} style={{ display: 'flex', gap: 12, maxWidth: '85%', alignSelf: isUser ? 'flex-end' : 'flex-start', flexDirection: isUser ? 'row-reverse' : 'row' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: avatarBg, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{avatarText}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, color: 'var(--meta)', textAlign: isUser ? 'right' : 'left' }}>
                      {msg.created_at ? new Date(msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                    <div style={{ padding: '10px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', ...bubbleStyle }}>
                      {msg.content}
                    </div>
                  </div>
                </div>
              )
            })}

            {/* Live tool use events */}
            {events.filter((e: any) => e.type === 'tool_use').map((ev: any, i: number) => (
              <div key={`tool-${i}`} style={{ display: 'flex', gap: 12, maxWidth: '85%' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--warn)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>!</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    padding: '10px 14px', borderRadius: 12, fontSize: 12, lineHeight: 1.5,
                    background: 'color-mix(in oklab, var(--warn), transparent 90%)',
                    color: 'var(--fg-2)', border: '1px dashed var(--border)',
                  }}>
                    🔧 <strong>{String(ev.data.name)}</strong>
                    {ev.data.input ? (
                      <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                        {JSON.stringify(ev.data.input).slice(0, 120)}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

            {/* AI response as assistant bubble */}
            {content && (
              <div style={{ display: 'flex', gap: 12, maxWidth: '85%' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--fg)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>AI</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    padding: '10px 14px', borderRadius: 12, borderBottomLeftRadius: 4,
                    background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border-soft)',
                    fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                  }}>
                    {content}
                  </div>
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !running) { e.preventDefault(); handleRun() }
              }}
              placeholder={running ? '运行中...' : '输入补充说明或追问...'}
              disabled={running}
              rows={1}
              style={{
                flex: 1, fontSize: 13, padding: '10px 14px',
                border: '1px solid var(--border)', borderRadius: 8,
                resize: 'none', minHeight: 40, maxHeight: 120,
                background: 'var(--bg)', color: 'var(--fg)', outline: 'none',
                fontFamily: 'var(--font-body)', lineHeight: 1.5,
              }}
              onFocus={(e) => e.currentTarget.style.borderColor = 'var(--accent)'}
              onBlur={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
            />
            {running ? (
              <button onClick={handleCancel} style={{
                width: 40, height: 40, borderRadius: '50%',
                background: 'var(--danger)', color: '#fff', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>■</button>
            ) : (
              <button onClick={handleRun} style={{
                width: 40, height: 40, borderRadius: '50%',
                background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 }}>
        <button className="btn-ghost" onClick={onClose}>关闭</button>
        <button className="btn-primary" onClick={() => {
          if (selectedStage < stages.length - 1) {
            setSelectedStage(selectedStage + 1)
          }
        }}>
          推进到下一阶段
        </button>
      </div>
    </div>
  )
}
