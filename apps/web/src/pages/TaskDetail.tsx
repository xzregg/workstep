import { useState, useEffect, useRef, useMemo } from 'react'
import { useTaskStore } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import { fsApi, projectApi, taskApi, type TaskArtifact, type TaskStepState } from '../api/client'
import ArtifactPreview from '../components/ArtifactPreview'

const EMPTY_EVENTS: any[] = []

const STATUS_LABELS: Record<string, string> = {
  ready: '预备中', running: '开始', paused: '暂停', stopped: '停止',
}

type StageVisualState = 'completed' | 'current' | 'failed' | 'skipped' | 'pending'

interface StageData {
  key: string
  label: string
  color: string
  prompt: string
  inputs: Array<{
    name: string
    type: string
    outputs?: Array<{ name: string; type: string }>
  }>
  outputs: Array<{ name: string; type: string }>
}

interface StageProgress extends Partial<TaskStepState> {
  visualState: StageVisualState
}

const STAGE_STATE_LABELS: Record<StageVisualState, string> = {
  completed: '已完成',
  current: '当前',
  failed: '失败',
  skipped: '已跳过',
  pending: '待处理',
}

interface TaskDetailProps {
  taskId: string
  onClose: () => void
}

export default function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const activeProject = useProjectStore((s) => s.activeProject)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] : undefined) ?? EMPTY_EVENTS)
  const content = useTaskStore((s) => (taskId ? s.content[taskId] : '') ?? '')
  const runTask = useTaskStore((s) => s.runTask)
  const cancelTask = useTaskStore((s) => s.cancelTask)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const updateTaskDescription = useTaskStore((s) => s.updateTaskDescription)

  const projectId = activeProject?.id || ''
  const task = tasks.find((t) => t.id === taskId)
  const taskStatus = task?.status
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [selectedStage, setSelectedStage] = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const stageLastMessageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const pendingStageScrollRef = useRef<string | null>(null)
  const [historyMessages, setHistoryMessages] = useState<any[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [previewArtifact, setPreviewArtifact] = useState<TaskArtifact | null>(null)
  const [artifactNotice, setArtifactNotice] = useState('')
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptSaveError, setPromptSaveError] = useState('')
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionSaving, setDescriptionSaving] = useState(false)
  const [descriptionError, setDescriptionError] = useState('')
  const historyFetchedRef = useRef<string>('')

  // Load historical messages when panel opens (or task changes)
  useEffect(() => {
    if (!taskId || !projectId) {
      historyFetchedRef.current = ''
      return
    }
    const fetchKey = `${taskId}-${projectId}`
    if (historyFetchedRef.current === fetchKey) return
    historyFetchedRef.current = fetchKey
    setHistoryLoading(true)
    taskApi.history(taskId, projectId, 50, 0)
      .then((res) => setHistoryMessages(res.messages || []))
      .catch(() => setHistoryMessages([]))
      .finally(() => setHistoryLoading(false))
  }, [taskId, projectId])

  useEffect(() => {
    if (!taskId || !projectId) {
      setArtifacts([])
      return
    }
    setArtifactsLoading(true)
    taskApi.artifacts(taskId, projectId)
      .then((res) => setArtifacts(res.artifacts || []))
      .catch(() => setArtifacts([]))
      .finally(() => setArtifactsLoading(false))
  }, [taskId, projectId])

  // Fetch tasks if not already loaded
  useEffect(() => {
    if (tasks.length === 0 && projectId) fetchTasks(projectId)
  }, [tasks.length, fetchTasks, projectId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events, content])

  useEffect(() => {
    if (historyLoading || !pendingStageScrollRef.current) return
    const stageKey = pendingStageScrollRef.current
    const frame = requestAnimationFrame(() => {
      stageLastMessageRefs.current[stageKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStageScrollRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [historyLoading, historyMessages])

  useEffect(() => {
    if (taskStatus) setRunning(taskStatus === 'running')
  }, [taskStatus])

  // Get stages from project steps
  const stages = useMemo<StageData[]>(() => {
    const steps = activeProject?.steps
    if (steps?.nodes?.length) return steps.nodes.map((n: any) => ({ key: n.type || n.key, label: n.title || n.label, color: n.color || '#888', prompt: n.prompt || '', inputs: (n.inputs || []).map((i: any) => ({ name: i.name, type: i.type, outputs: i.outputs || [] })), outputs: (n.outputs || []).map((o: any) => ({ name: o.name, type: o.type })) }))
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({ key: s.key || s.id, label: s.label || s.name, color: s.color || '#888', prompt: s.prompt || '', inputs: (s.inputs || []).map((i: any) => ({ name: i.name || i, type: i.type || 'any', outputs: i.outputs || [] })), outputs: (s.outputs || []).map((o: any) => ({ name: o.name || o, type: o.type || 'any' })) }))
    return [{ key: 'do', label: '执行', color: '#0071e3', prompt: '', inputs: [], outputs: [] }]
  }, [activeProject?.steps])

  const stageProgress = useMemo<StageProgress[]>(() => {
    const stepByKey = new Map(
      (task?.steps || []).map((step) => [step.step_key, step]),
    )
    const rawStatuses: TaskStepState['status'][] = stages.map(
      (stage: any) => stepByKey.get(stage.key)?.status || 'pending',
    )
    let activeIndex = rawStatuses.findIndex((status) => status === 'running')
    if (activeIndex < 0) {
      activeIndex = rawStatuses.findIndex((status) => status === 'failed')
    }
    if (activeIndex < 0) {
      activeIndex = rawStatuses.findIndex((status) => status === 'pending')
    }

    return stages.map((stage, index) => {
      const step = stepByKey.get(stage.key)
      const status = rawStatuses[index]
      let visualState: StageVisualState = 'pending'
      if (status === 'passed') visualState = 'completed'
      else if (status === 'running') visualState = 'current'
      else if (status === 'failed') visualState = 'failed'
      else if (status === 'skipped') visualState = 'skipped'
      else if (index === activeIndex) visualState = 'current'
      return { ...step, visualState }
    })
  }, [stages, task?.steps])

  const activeStageIndex = useMemo(() => {
    const current = stageProgress.findIndex((progress: StageProgress) =>
      progress.visualState === 'current'
    )
    if (current >= 0) return current
    const failed = stageProgress.findIndex((progress: StageProgress) =>
      progress.visualState === 'failed'
    )
    return failed >= 0 ? failed : Math.max(0, stages.length - 1)
  }, [stageProgress, stages.length])

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
  const activeStage = stages[activeStageIndex] || stages[0]
  const currentStageColor = currentStage.color || 'var(--accent)'
  const activeStageColor = activeStage.color || 'var(--accent)'
  const time = new Date(task.created_at * 1000).toLocaleString('zh-CN')

  const openDescriptionEditor = () => {
    setDescriptionDraft(task.description || '')
    setDescriptionError('')
    setEditingDescription(true)
  }

  const saveDescription = async () => {
    if (!projectId) return
    setDescriptionSaving(true)
    setDescriptionError('')
    try {
      await updateTaskDescription(task.id, descriptionDraft, projectId)
      setEditingDescription(false)
    } catch (error) {
      setDescriptionError(
        error instanceof Error ? error.message : '任务说明保存失败'
      )
    } finally {
      setDescriptionSaving(false)
    }
  }

  const openPromptEditor = () => {
    setPromptDraft(currentStage.prompt)
    setPromptSaveError('')
    setShowPromptEditor(true)
  }

  const saveStagePrompt = async () => {
    if (!activeProject) return
    const currentSteps = activeProject.steps
    let nextSteps = currentSteps
    if (currentSteps?.nodes?.length) {
      nextSteps = {
        ...currentSteps,
        nodes: currentSteps.nodes.map((node: any) =>
          (node.type || node.key) === currentStage.key
            ? { ...node, prompt: promptDraft }
            : node
        ),
      }
    } else if (currentSteps?.steps?.length) {
      nextSteps = {
        ...currentSteps,
        steps: currentSteps.steps.map((step: any) =>
          (step.key || step.id) === currentStage.key
            ? { ...step, prompt: promptDraft }
            : step
        ),
      }
    }

    setPromptSaving(true)
    setPromptSaveError('')
    try {
      await projectApi.saveSteps(activeProject.id, nextSteps)
      setActiveProject({ ...activeProject, steps: nextSteps })
      setShowPromptEditor(false)
    } catch (error) {
      setPromptSaveError(
        `保存失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    } finally {
      setPromptSaving(false)
    }
  }

  const handleStageClick = (stageIndex: number) => {
    setSelectedStage(stageIndex)
    const stageKey = stages[stageIndex]?.key
    if (!stageKey) return

    pendingStageScrollRef.current = stageKey
    if (historyLoading) return

    requestAnimationFrame(() => {
      stageLastMessageRefs.current[stageKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStageScrollRef.current = null
    })
  }

  const findArtifact = (name: string, preferredStepKey?: string) => {
    const normalize = (value: string) =>
      value.toLocaleLowerCase().replace(/[\s_.-]/g, '')
    const normalizedName = normalize(name)
    const candidates = preferredStepKey
      ? artifacts.filter((artifact) => artifact.step_key === preferredStepKey)
      : artifacts
    return candidates.find((artifact) => artifact.logical_name === name)
      || candidates.find((artifact) => {
        const artifactName = normalize(artifact.logical_name || artifact.name)
        return artifactName.includes(normalizedName)
          || normalizedName.includes(artifactName)
      })
  }

  const openArtifact = (name: string, preferredStepKey?: string) => {
    if (artifactsLoading) {
      setArtifactNotice('产物正在加载，请稍后再试')
    } else {
      const artifact = findArtifact(name, preferredStepKey)
      if (artifact) {
        setPreviewArtifact(artifact)
        setArtifactNotice('')
        return
      }
      setArtifactNotice(`未找到“${name}”对应的产物文件`)
    }
    setTimeout(() => setArtifactNotice(''), 3000)
  }

  const openArtifactDirectory = async () => {
    if (!previewArtifact) return
    try {
      const result = await fsApi.openDirectory(previewArtifact.path)
      setArtifactNotice(`已打开目录：${result.path}`)
    } catch (error) {
      setArtifactNotice(
        `打开目录失败：${error instanceof Error ? error.message : '未知错误'}`
      )
    }
    setTimeout(() => setArtifactNotice(''), 3000)
  }

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
              background: `color-mix(in oklab, ${activeStageColor}, transparent 85%)`,
              color: activeStageColor,
            }}>
              {activeStage.label} · 当前阶段
            </span>
            <span style={{ fontSize: 12, color: 'var(--meta)' }}>{time}</span>
          </div>
        </div>
      </div>

      {/* ── Content split ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* ── Left panel ── */}
        <div style={{ width: '45%', minWidth: 380, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 24, borderRight: '1px solid var(--border-soft)' }}>

          <div>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 8,
            }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}>
                任务说明
              </div>
              {!editingDescription && (
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label="编辑任务说明"
                  onClick={openDescriptionEditor}
                  style={{ height: 28, padding: '0 9px', fontSize: 11, gap: 4 }}
                >
                  <span aria-hidden="true">✎</span>
                  编辑
                </button>
              )}
            </div>
            {editingDescription ? (
              <div>
                <textarea
                  aria-label="编辑任务说明"
                  value={descriptionDraft}
                  disabled={descriptionSaving}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  placeholder="输入任务说明…"
                  autoFocus
                  style={{
                    width: '100%', height: 'min(33vh, 260px)', minHeight: 140,
                    padding: '10px 12px', fontSize: 13, lineHeight: 1.6,
                  }}
                />
                {descriptionError && (
                  <div role="alert" style={{
                    marginTop: 6, color: 'var(--danger)', fontSize: 11,
                  }}>
                    {descriptionError}
                  </div>
                )}
                <div style={{
                  display: 'flex', justifyContent: 'flex-end',
                  gap: 8, marginTop: 8,
                }}>
                  <button
                    className="btn-ghost"
                    disabled={descriptionSaving}
                    onClick={() => setEditingDescription(false)}
                  >
                    取消
                  </button>
                  <button
                    className="btn-primary"
                    disabled={descriptionSaving}
                    onClick={() => void saveDescription()}
                  >
                    {descriptionSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{
                padding: '10px 12px', borderRadius: 8,
                border: '1px solid var(--border-soft)',
                background: 'var(--surface)',
                color: task.description ? 'var(--fg-2)' : 'var(--meta)',
                fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere', maxHeight: '33vh', overflowY: 'auto',
                fontStyle: task.description ? 'normal' : 'italic',
              }}>
                {task.description || '暂无任务说明'}
              </div>
            )}
          </div>

          {/* Progress timeline */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>进度</div>
            <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
              {stages.map((stage: any, i: number) => {
                const progress = stageProgress[i]
                const visualState = progress?.visualState || 'pending'
                const isCompleted = visualState === 'completed'
                const isCurrentActive = visualState === 'current'
                const isFailed = visualState === 'failed'
                const isSkipped = visualState === 'skipped'
                const isSelected = i === selectedStage
                const stageColor = stage.color || 'var(--accent)'
                const activeStateColor = task.status === 'paused'
                  ? 'var(--status-paused)'
                  : task.status === 'stopped'
                    ? 'var(--status-stopped)'
                    : 'var(--status-running)'
                const stateColor = isCompleted
                  ? 'var(--status-done)'
                    : isFailed
                      ? 'var(--status-failed)'
                      : isCurrentActive
                      ? activeStateColor
                      : isSkipped
                        ? 'var(--meta)'
                        : 'var(--border)'
                return (
                  <div
                    key={stage.key}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看${stage.label}阶段的最后一条聊天记录`}
                    onClick={() => handleStageClick(i)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleStageClick(i)
                      }
                    }}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', paddingTop: 24, cursor: 'pointer', outline: 'none' }}
                  >
                    {/* Connector line */}
                    <div style={{
                      position: 'absolute', top: 10,
                      left: i === 0 ? '50%' : 0, right: i === stages.length - 1 ? '50%' : 0,
                      height: 2, background: stateColor,
                    }} />
                    {/* Dot */}
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: isCompleted || isCurrentActive || isFailed || isSkipped
                        ? stateColor
                        : 'var(--bg)',
                      border: `2px solid ${stateColor}`,
                      position: 'relative', zIndex: 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 12, fontWeight: 700,
                    }}>
                      {isCompleted ? '✓' : isFailed ? '×' : isSkipped ? '–' : ''}
                    </div>
                    <span style={{
                      fontSize: 11, marginTop: 8, textAlign: 'center', whiteSpace: 'nowrap',
                      color: stageColor,
                      fontWeight: isSelected || isCurrentActive ? 600 : 400,
                      textDecoration: isSelected ? 'underline' : 'none',
                      textUnderlineOffset: '3px',
                    }}>
                      {stage.label}
                    </span>
                    {visualState !== 'pending' && (
                      <span style={{
                        fontSize: 9, marginTop: 3, padding: '1px 5px',
                        borderRadius: 999,
                        color: stateColor,
                        background: `color-mix(in oklab, ${stateColor}, transparent 88%)`,
                        fontWeight: 600,
                      }}>
                        {STAGE_STATE_LABELS[visualState]}
                      </span>
                    )}
                    {/* Time info for active stage */}
                    {isCurrentActive && (
                      <div style={{ fontSize: 10, color: 'var(--meta)', marginTop: 4, textAlign: 'center', lineHeight: 1.5 }}>
                        <div>开始: {new Date((progress?.started_at || task.created_at) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
                        {progress?.started_at && task.updated_at > progress.started_at && (
                          <span style={{ color: 'var(--fg-2)', fontWeight: 500 }}>
                            {Math.max(1, Math.round((task.updated_at - progress.started_at) / 60))}分钟
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
            <div style={{ fontSize: 12, fontWeight: 600, color: currentStageColor, marginBottom: 8 }}>
              阶段输入输出 — {currentStage.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--meta)' }}>→</span> 输入
                </div>
                {(() => {
                  const isStageDone = stageProgress[selectedStage]?.visualState === 'completed'
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
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={`打开输入文件 ${inp.name}`}
                          onClick={() => openArtifact(inp.name)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openArtifact(inp.name)
                            }
                          }}
                          title={`打开“${inp.name}”对应的文件`}
                          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border-soft)', cursor: 'pointer' }}
                        >
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: currentStageColor, flexShrink: 0 }} />
                          <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{inp.name}</span>
                          <span style={{ fontSize: 11, color: currentStageColor }}>查看</span>
                          <span style={{ fontSize: 11, color: 'var(--meta)', background: 'var(--surface)', border: '1px solid var(--border-soft)', padding: '0 4px', borderRadius: 3 }}>{inp.type}</span>
                        </div>
                        {/* Sub-outputs (only on first input) */}
                        {subOutputs.map((out: any, outIdx: number) => {
                          const nextInput = nextInputs[outIdx]
                          const statusDone = isStageDone
                          return (
                            <div
                              key={outIdx}
                              role="button"
                              tabIndex={0}
                              aria-label={`打开输出文件 ${out.name}`}
                              onClick={() => openArtifact(out.name, currentStage.key)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  openArtifact(out.name, currentStage.key)
                                }
                              }}
                              title={`打开“${out.name}”对应的文件`}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 18, padding: '4px 8px', cursor: 'pointer', borderRadius: 4 }}
                            >
                              <span style={{ color: 'var(--meta)', fontSize: 11 }}>↳</span>
                              <div style={{ width: 6, height: 6, borderRadius: '50%', background: statusDone ? 'var(--success)' : currentStageColor, flexShrink: 0 }} />
                              <span style={{ fontSize: 12, flex: 1 }}>{out.name}</span>
                              <span style={{ fontSize: 10, color: currentStageColor }}>打开</span>
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
          <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>阶段提示词</div>
                <button
                  className="btn-ghost"
                  onClick={openPromptEditor}
                  style={{ height: 28, padding: '0 9px', fontSize: 12, gap: 4 }}
                >
                  <span aria-hidden="true">✎</span>
                  快速编辑
                </button>
              </div>
              <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', borderLeft: `3px solid ${currentStageColor}` }}>
                <div style={{ fontSize: 13, color: currentStage.prompt ? 'var(--fg-2)' : 'var(--meta)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {currentStage.prompt || '尚未配置阶段提示词'}
                </div>
              </div>
            </div>
        </div>

        {/* ── Right panel: Chat ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
          {/* Chat header */}
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>对话记录</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: currentStageColor, background: `color-mix(in oklab, ${currentStageColor}, transparent 88%)`, padding: '2px 8px', borderRadius: 4 }}>
              {currentStage.label}
            </span>
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

            {/* Historical messages grouped by stage */}
            {(() => {
              const stageMessages: Record<string, any[]> = {}
              historyMessages.forEach((msg: any) => {
                const stage = msg.step_key || 'unknown'
                if (!stageMessages[stage]) stageMessages[stage] = []
                stageMessages[stage].push(msg)
              })

              return Object.entries(stageMessages).map(([stageKey, msgs]) => {
                const stageInfo = stages.find((s: any) => s.key === stageKey)
                const stageLabel = stageInfo?.label || stageKey
                return (
                  <div key={stageKey} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Stage header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-soft)' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: stageInfo?.color || 'var(--accent)', background: `color-mix(in oklab, ${stageInfo?.color || 'var(--accent)'}, transparent 85%)`, padding: '2px 8px', borderRadius: 4 }}>
                        {stageLabel}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--meta)' }}>
                        {msgs[0]?.created_at ? new Date(msgs[0].created_at * 1000).toLocaleString('zh-CN') : ''}
                      </span>
                    </div>

                    {/* Messages in this stage */}
                    {msgs.map((msg: any, i: number) => {
                      const isUser = msg.role === 'user'
                      const isSystem = msg.role === 'system'
                      const sender = isUser ? '我' : isSystem ? '系统' : stageLabel
                      const initials = sender.slice(0, 2)
                      const senderColor = isUser ? 'var(--accent)' : isSystem ? 'var(--warn)' : (stageInfo?.color || 'var(--fg)')

                      return (
                        <div
                          key={i}
                          ref={i === msgs.length - 1
                            ? (element) => {
                                stageLastMessageRefs.current[stageKey] = element
                              }
                            : undefined}
                          data-stage-last-message={i === msgs.length - 1 ? stageKey : undefined}
                          style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '85%', alignSelf: isUser ? 'flex-end' : 'flex-start' }}
                        >
                          {/* Time above message */}
                          <div style={{ fontSize: 10, color: 'var(--meta)', textAlign: isUser ? 'right' : 'left', paddingLeft: isUser ? 0 : 44, paddingRight: isUser ? 44 : 0 }}>
                            {msg.created_at ? new Date(msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}
                          </div>
                          {/* Message row */}
                          <div style={{ display: 'flex', gap: 12, flexDirection: isUser ? 'row-reverse' : 'row' }}>
                            <div style={{
                              width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                              background: senderColor, color: '#fff',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 12, fontWeight: 600,
                            }}>
                              {initials}
                            </div>
                            <div style={{
                              flex: 1, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                              color: isUser ? '#fff' : 'var(--fg-2)',
                              background: isUser ? 'var(--accent)' : 'var(--surface)',
                              padding: '10px 14px', borderRadius: 12,
                              borderBottomRightRadius: isUser ? 4 : 12,
                              borderBottomLeftRadius: isUser ? 12 : 4,
                            }}>
                              {msg.content}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })
            })()}

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
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: activeStageColor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>AI</div>
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

      {artifactNotice && (
        <div style={{
          position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)',
          zIndex: 1300, padding: '8px 16px', borderRadius: 6,
          background: 'var(--fg)', color: 'var(--bg)', fontSize: 13,
          boxShadow: 'var(--elev-raised)',
        }}>
          {artifactNotice}
        </div>
      )}

      {showPromptEditor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`快速编辑${currentStage.label}阶段提示词`}
          style={{
            position: 'fixed', inset: 0, zIndex: 1275,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
          onClick={() => !promptSaving && setShowPromptEditor(false)}
        >
          <div
            style={{
              width: 'min(680px, 90vw)', background: 'var(--bg)',
              borderRadius: 12, boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
              overflow: 'hidden',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ padding: '15px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: currentStageColor }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>快速编辑阶段提示词</div>
                <div style={{ marginTop: 2, fontSize: 11, color: 'var(--meta)' }}>{currentStage.label} · {currentStage.key}</div>
              </div>
              <button className="btn-icon" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>✕</button>
            </div>
            <div style={{ padding: 18 }}>
              <textarea
                autoFocus
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                placeholder="描述该阶段的目标、输入、执行要求和输出规范……"
                rows={12}
                style={{
                  minHeight: 260, resize: 'vertical',
                  fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.6,
                }}
              />
              {promptSaveError && (
                <div role="alert" style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>
                  {promptSaveError}
                </div>
              )}
            </div>
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-ghost" disabled={promptSaving} onClick={() => setShowPromptEditor(false)}>取消</button>
              <button className="btn-primary" disabled={promptSaving} onClick={saveStagePrompt}>
                {promptSaving ? '保存中…' : '保存提示词'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewArtifact && (
        <div
          role="dialog"
          aria-label={`产物预览 ${previewArtifact.logical_name || previewArtifact.name}`}
          style={{
            position: 'fixed', inset: 0, zIndex: 1250,
            background: 'rgba(0,0,0,0.35)', padding: '5vh 6vw',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setPreviewArtifact(null)}
        >
          <div
            style={{
              width: 'min(900px, 90vw)', height: 'min(720px, 88vh)',
              background: 'var(--bg)', borderRadius: 12, overflow: 'hidden',
              boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
              display: 'flex', flexDirection: 'column',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {previewArtifact.logical_name || previewArtifact.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--meta)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewArtifact.path}
                </div>
              </div>
              <button className="btn-ghost" onClick={openArtifactDirectory}>
                打开所在目录
              </button>
              <button className="btn-icon" onClick={() => setPreviewArtifact(null)}>✕</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ArtifactPreview path={previewArtifact.path} onClose={() => setPreviewArtifact(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
