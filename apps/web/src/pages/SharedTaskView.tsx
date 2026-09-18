import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import Button from '../components/Button'
import Input from '../components/Input'
import Spinner from '../components/Spinner'
import TaskDetailPage from '../components/TaskDetailPage'
import type {
  StageData,
  StageProgress,
  StageVisualState,
} from '../components/TaskDetailView'
import {
  shareApi,
  type ReviewRun,
  type ShareMeta,
  type SharedTask,
  type TaskArtifact,
} from '../api/client'
import {
  createOptimisticUserMessage,
  isStageResumableWithMessage,
  isTaskCompleted,
  isTaskNotStarted,
  resolveStageDisplayStatus,
  resolveTaskDetailAdvanceState,
  findPreferredArtifact,
} from './taskDetailChat'
import { a2uiActionMessageParams } from '../utils/a2ui'
import { useI18n } from '../i18n'

type Phase =
  | { kind: 'loading-meta' }
  | { kind: 'need-password'; meta: ShareMeta }
  | { kind: 'unlocking'; meta: ShareMeta; password: string }
  | { kind: 'loading-task' }
  | { kind: 'ready'; sessionToken: string }
  | { kind: 'error'; message: string }

const MAX_LIVE_SHARED_EVENTS = 2000

function appendCappedSharedEvent(events: any[] | undefined, event: any): any[] {
  const combined = [...(events ?? []), event]
  return combined.length > MAX_LIVE_SHARED_EVENTS
    ? combined.slice(-MAX_LIVE_SHARED_EVENTS)
    : combined
}

function capSharedHistoryEvents(message: any): any {
  return Array.isArray(message?.events) && message.events.length > MAX_LIVE_SHARED_EVENTS
    ? { ...message, events: message.events.slice(-MAX_LIVE_SHARED_EVENTS) }
    : message
}

export default function SharedTaskView() {
  const { token } = useParams<{ token: string }>()
  const { t, locale } = useI18n()

  const [phase, setPhase] = useState<Phase>({ kind: 'loading-meta' })
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [task, setTask] = useState<SharedTask | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [artifacts, setArtifacts] = useState<TaskArtifact[]>([])
  const [reviews, setReviews] = useState<ReviewRun[]>([])
  const [previewArtifact, setPreviewArtifact] =
    useState<TaskArtifact | null>(null)
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'live'>('disconnected')
  const [selectedStage, setSelectedStage] = useState(0)
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  const [chatTarget, setChatTarget] = useState<string | 'coordinator'>('coordinator')
  const [prompt, setPrompt] = useState('')
  const [chatError, setChatError] = useState('')
  const [stoppingStepKeys, setStoppingStepKeys] = useState<string[]>([])
  const [reviewActionPending, setReviewActionPending] = useState(false)
  const [reviewComment, setReviewComment] = useState('')
  const selectedStageTaskRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reunlockAttemptsRef = useRef(0)

  const isAuthError = useCallback((err: unknown) =>
    /401/i.test(err instanceof Error ? err.message : String(err)), [])

  const loadWithSession = useCallback(async (sessionToken: string) => {
    if (!token) return
    setPhase({ kind: 'loading-task' })
    const [taskData, historyData, artifactsData, reviewsData] = await Promise.all([
      shareApi.task(token, sessionToken),
      shareApi.history(token, sessionToken),
      shareApi.artifacts(token, sessionToken),
      shareApi.reviews(token, sessionToken).catch(() => ({ reviews: [] })),
    ])
    setTask(taskData)
    setMessages(historyData.messages.map(capSharedHistoryEvents))
    setArtifacts(artifactsData.artifacts)
    setReviews(reviewsData.reviews || [])
    setPhase({ kind: 'ready', sessionToken })
  }, [token])

  const recoverSession = useCallback(async (m: ShareMeta) => {
    if (!token || !m) return
    if (m.has_password) {
      // Requires the visitor to re-enter the password.
      setPhase({ kind: 'need-password', meta: m })
      return
    }
    if (reunlockAttemptsRef.current >= 2) {
      setPhase({ kind: 'error', message: t('share.sessionExpired') })
      return
    }
    reunlockAttemptsRef.current += 1
    try {
      const { session_token } = await shareApi.unlock(token, '')
      await loadWithSession(session_token)
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [token, loadWithSession, t])

  // Fetch share meta on mount.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    setPhase({ kind: 'loading-meta' })
    shareApi
      .meta(token)
      .then((m) => {
        if (cancelled) return
        setMeta(m)
        // If the share has no password, auto-unlock immediately.
        // The unlock endpoint accepts an empty password for no-password shares.
        if (!m.has_password) {
          setPhase({ kind: 'unlocking', meta: m, password: '' })
          shareApi.unlock(token, '').then(({ session_token }) => {
            if (cancelled) return
            return loadWithSession(session_token)
          }).catch((err: Error) => {
            if (cancelled) return
            if (isAuthError(err)) {
              void recoverSession(m)
            } else {
              setPhase({ kind: 'error', message: err.message })
            }
          })
        } else {
          setPhase({ kind: 'need-password', meta: m })
        }
      })
      .catch((err: Error) => {
        if (cancelled) return
        setPhase({ kind: 'error', message: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [token, loadWithSession, recoverSession, isAuthError])

  const handleUnlock = useCallback(async () => {
    if (!token || !meta || !password) return
    if (password.length < 4) {
      setError(t('share.passwordTooShort'))
      return
    }
    setError(null)
    setPhase({ kind: 'unlocking', meta, password })
    try {
      const { session_token: sessionToken } = await shareApi.unlock(token, password)
      setPhase({ kind: 'loading-task' })
      await loadWithSession(sessionToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/401/i.test(message)) {
        if (meta.has_password) {
          setError(t('share.incorrectPassword'))
          setPhase({ kind: 'need-password', meta })
        } else {
          void recoverSession(meta)
        }
      } else {
        setPhase({ kind: 'error', message })
      }
    }
  }, [token, meta, password, t, loadWithSession, recoverSession])

  // Connect WebSocket once unlocked. The message/task setters are captured
  // via closure so the onmessage handler can mutate state directly.
  useEffect(() => {
    if (phase.kind !== 'ready') return
    const sessionToken = phase.sessionToken
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 500

    // Captured token for this effect's lifetime. If the session changes,
    // a new effect runs and closes the previous connection.
    const currentToken = token!

    const applyEvent = (ev: any) => {
      const evType = ev?.type
      const mid = ev?.messageId ?? ev?.message_id
      const isTextChunk = evType === 'text_delta' || evType === 'TEXT_MESSAGE_CHUNK'
      const isReasoning = evType === 'thinking_delta' || evType === 'REASONING_MESSAGE_CHUNK'
      const isInteraction = evType === 'interaction_request'
        || evType === 'interaction_response'
        || ev?.name === 'workstep.interaction_request'
        || ev?.name === 'workstep.interaction_response'
      if (isTextChunk || isReasoning) {
        const messageId = mid
        if (!messageId) return
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId)
          if (idx === -1) {
            const created = {
              id: messageId,
              role: 'assistant',
              content: isTextChunk ? (ev.delta ?? ev.text ?? '') : '',
              step_key: ev.step_key,
              channel: 'execution',
              run_status: 'running',
              events: isReasoning ? [ev] : [],
              started_at: ev.created_at ?? new Date().toISOString(),
              ended_at: null,
              created_at: ev.created_at ?? new Date().toISOString(),
            }
            return [...prev, created]
          }
          const existing = prev[idx]
          const next = { ...existing }
          if (isTextChunk) {
            next.content = (next.content ?? '') + (ev.delta ?? ev.text ?? '')
          } else {
            next.events = appendCappedSharedEvent(next.events, ev)
          }
          const copy = prev.slice()
          copy[idx] = next
          return copy
        })
      } else if (
        evType === 'tool_use' ||
        evType === 'tool_input_delta' ||
        evType === 'tool_result' ||
        evType === 'TOOL_CALL_START' ||
        evType === 'TOOL_CALL_ARGS' ||
        evType === 'TOOL_CALL_CHUNK' ||
        evType === 'TOOL_CALL_RESULT'
      ) {
        const messageId = mid
        if (!messageId) return
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId)
          if (idx === -1) return prev
          const existing = prev[idx]
          const next = { ...existing, events: appendCappedSharedEvent(existing.events, ev) }
          const copy = prev.slice()
          copy[idx] = next
          return copy
        })
      } else if (isInteraction) {
        const messageId = mid
        if (!messageId) return
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId)
          if (idx === -1) return prev
          const existing = prev[idx]
          const next = { ...existing, events: appendCappedSharedEvent(existing.events, ev) }
          const copy = prev.slice()
          copy[idx] = next
          return copy
        })
      } else if (
        evType === 'status' ||
        evType === 'done' ||
        evType === 'RUN_STARTED' ||
        evType === 'RUN_FINISHED' ||
        evType === 'RUN_ERROR'
      ) {
        const messageId = mid
        if (messageId) {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === messageId)
            if (idx === -1) return prev
            const existing = prev[idx]
            const next = {
              ...existing,
              run_status: ev.status ?? existing.run_status,
              ended_at: ev.created_at ?? existing.ended_at ?? new Date().toISOString(),
            }
            const copy = prev.slice()
            copy[idx] = next
            return copy
          })
        }
      }
      // Stage/status events also refresh the task to keep the progress
      // panel in sync with the conversation.
      if (
        evType === 'status' ||
        evType === 'RUN_STARTED' ||
        evType === 'RUN_FINISHED' ||
        evType === 'RUN_ERROR' ||
        evType === 'review_status' ||
        evType === 'review_result' ||
        evType === 'step_retrying' ||
        ev?.type === 'CUSTOM' && (
          ev?.name === 'workstep.status' ||
          ev?.name === 'workstep.step_retrying' ||
          ev?.name === 'workstep.run_recovered' ||
          ev?.name === 'workstep.review_status' ||
          ev?.name === 'workstep.review_result'
        )
      ) {
        const shouldRefreshReviews = evType === 'review_status'
          || evType === 'review_result'
          || ev?.name === 'workstep.review_status'
          || ev?.name === 'workstep.review_result'
        shareApi
          .task(currentToken, sessionToken)
          .then((fresh) => {
            if (!closed) setTask(fresh)
          })
          .catch(() => {
            /* swallow */
          })
        if (shouldRefreshReviews) {
          shareApi
            .reviews(currentToken, sessionToken)
            .then((fresh) => {
              if (!closed) setReviews(fresh.reviews || [])
            })
            .catch(() => {
              /* swallow */
            })
        }
      }
    }

    const connect = () => {
      if (closed) return
      setWsStatus('connecting')
      const ws = new WebSocket(shareApi.buildWsUrl(sessionToken))
      wsRef.current = ws
      ws.onopen = () => {
        if (closed) return
        setWsStatus('live')
        backoffMs = 500
      }
      ws.onmessage = (event) => {
        try {
          applyEvent(JSON.parse(event.data))
        } catch {
          // ignore malformed
        }
      }
      ws.onerror = () => {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null
        if (closed) return
        setWsStatus('disconnected')
        // Daemon restarted or the share was revoked: the in-memory session
        // token is gone, so re-unlock instead of retrying a dead session.
        if (event.code === 4401) {
          if (meta) void recoverSession(meta)
          return
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, backoffMs)
        backoffMs = Math.min(backoffMs * 2, 15000)
      }
    }

    connect()
    return () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      wsRef.current = null
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }
  }, [phase, token, recoverSession, meta])

  // ── Stage data for TaskDetailView (read-only mode) ──────────────────
  // Prefer the workflow definition as the source of truth for stage order
  // and metadata (title / color / prompt / I/O). Task step rows may be
  // ordered by step_key, so statuses are mapped back by step_key below.

  const workflowNodes = useMemo(
    () =>
      Array.isArray(task?.workflow?.steps?.nodes)
        ? (task!.workflow!.steps!.nodes as any[])
        : [],
    [task?.workflow],
  )

  const nodeStepKey = (node: any) =>
    node.key || node.type || node.id || ''

  const stages = useMemo<StageData[]>(() => {
    const steps = task?.steps || []
    if (workflowNodes.length > 0) {
      const keyByNodeId = new Map<string, string>()
      workflowNodes.forEach((node, index) => {
        keyByNodeId.set(
          String(node.id ?? index + 1),
          String(nodeStepKey(node)),
        )
      })
      const dependsByKey = new Map<string, string[]>()
      const reworkDependsByKey = new Map<string, string[]>()
      const rawConnections = Array.isArray(task?.workflow?.steps?.connections)
        ? task!.workflow!.steps!.connections
        : []
      rawConnections.forEach((connection: any) => {
        const fromKey = keyByNodeId.get(String(connection.from))
        const toKey = keyByNodeId.get(String(connection.to))
        if (!fromKey || !toKey || fromKey === toKey) return
        const isDashed = connection.kind === 'dashed'
          || /dashed|rework/.test(String(connection.style || ''))
        const targetMap = isDashed ? reworkDependsByKey : dependsByKey
        targetMap.set(toKey, [...new Set([...(targetMap.get(toKey) ?? []), fromKey])])
      })
      return workflowNodes.map((node) => ({
        key: String(nodeStepKey(node)),
        nodeId: node.id,
        label: node.title || node.label || nodeStepKey(node),
        color: node.color || 'var(--accent)',
        dependsOn: dependsByKey.get(String(nodeStepKey(node))) ?? [],
        reworkDependsOn: reworkDependsByKey.get(String(nodeStepKey(node))) ?? [],
        engine: node.engine || '',
        model: node.model || '',
        prompt: node.prompt || '',
        config: node.config || {},
        inputs: (node.inputs || []).map((input: any) => ({
          name: input.name,
          type: input.type,
          outputs: input.outputs || [],
        })),
        outputs: (node.outputs || []).map((output: any) => ({
          name: output.name,
          type: output.type,
        })),
      }))
    }
    return steps.map((step) => ({
      key: step.step_key,
      label: step.step_key,
      color: 'var(--accent)',
      dependsOn: [],
      reworkDependsOn: [],
      prompt: '',
      inputs: [],
      outputs: [],
    }))
  }, [task?.steps, workflowNodes])

  const stageProgress = useMemo<StageProgress[]>(() => {
    const steps = task?.steps || []
    const stepByKey = new Map(
      steps.map((step) => [step.step_key, step]),
    )
    const keys =
      workflowNodes.length > 0
        ? workflowNodes.map((node) => nodeStepKey(node))
        : steps.map((step) => step.step_key)
    const rawStatuses = keys.map((key) => {
      const step = stepByKey.get(key)
      return resolveStageDisplayStatus(
        step?.status || 'pending',
        step?.previous_status,
      )
    })
    let activeIndex = rawStatuses.findIndex((status) =>
      ['running', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting'].includes(
        status,
      ),
    )
    if (activeIndex < 0) {
      activeIndex = rawStatuses.findIndex((status) => status === 'failed')
    }
    if (activeIndex < 0) {
      activeIndex = rawStatuses.findIndex((status) => status === 'pending')
    }
    return keys.map((key, index) => {
      const step = stepByKey.get(key)
      const status = rawStatuses[index]
      let visualState: StageVisualState = 'pending'
      if (status === 'passed') visualState = 'completed'
      else if (status === 'reviewing') visualState = 'reviewing'
      else if (status === 'awaiting_review') visualState = 'awaiting_review'
      else if (status === 'retrying') visualState = 'retrying'
      else if (status === 'rework') visualState = 'rework'
      else if (status === 'rework_waiting') visualState = 'rework_waiting'
      else if (status === 'running') visualState = 'current'
      else if (status === 'failed' || status === 'rejected') visualState = 'failed'
      else if (status === 'cancelled') visualState = 'cancelled'
      else if (status === 'skipped') visualState = 'skipped'
      else if (index === activeIndex) visualState = 'current'
      return { ...step, visualState }
    })
  }, [task?.steps, workflowNodes])

  const activeStageIndex = useMemo(() => {
    const current = stageProgress.findIndex((progress: StageProgress) =>
      [
        'current',
        'reviewing',
        'awaiting_review',
        'retrying',
        'rework',
        'rework_waiting',
      ].includes(progress.visualState),
    )
    if (current >= 0) return current
    const failed = stageProgress.findIndex(
      (progress: StageProgress) => progress.visualState === 'failed',
    )
    return failed >= 0 ? failed : Math.max(0, stages.length - 1)
  }, [stageProgress, stages.length])

  useEffect(() => {
    if (!task?.id || selectedStageTaskRef.current === task.id) return
    setSelectedStage(activeStageIndex)
    selectedStageTaskRef.current = task.id
  }, [activeStageIndex, task?.id])

  const shouldTickDuration =
    task?.status === 'running' ||
    stageProgress.some((progress) =>
      [
        'reviewing',
        'awaiting_review',
        'retrying',
        'rework',
        'rework_waiting',
      ].includes(progress.visualState),
    )

  useEffect(() => {
    if (!shouldTickDuration) return
    setDurationNowMs(Date.now())
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [shouldTickDuration])

  const currentStage =
    stages[selectedStage] ||
    stages[0] || {
      key: '',
      label: '',
      color: 'var(--accent)',
      prompt: '',
      inputs: [],
      outputs: [],
    }
  const activeStage = stages[activeStageIndex] || currentStage
  const currentStageColor = currentStage.color || 'var(--accent)'
  const activeStageColor = activeStage.color || 'var(--accent)'
  const executionStageModel = activeStage?.model || task?.model || ''
  const taskCompleted = isTaskCompleted(task?.steps || [])
  const interactive = meta?.mode === 'interactive'
  const runningStages = useMemo(
    () => stages.filter((stage) => (
      stageProgress.some((progress) => (
        progress.step_key === stage.key && progress.status === 'running'
      ))
    )),
    [stages, stageProgress],
  )

  const resumableStages = useMemo(
    () => stages.filter((stage) => (
      stageProgress.some((progress) => (
        progress.step_key === stage.key
        && isStageResumableWithMessage(progress.status, progress.has_history)
      ))
    )),
    [stages, stageProgress],
  )

  useEffect(() => {
    if (!interactive) return
    setChatTarget((current) => {
      if (runningStages.some((stage) => stage.key === current)) return current
      if (resumableStages.some((stage) => stage.key === current)) return current
      return runningStages[0]?.key ?? resumableStages[0]?.key ?? current
    })
  }, [interactive, runningStages, resumableStages])

  const refreshSharedTask = useCallback(async (sessionToken: string) => {
    if (!token) return
    const fresh = await shareApi.task(token, sessionToken)
    setTask(fresh)
  }, [token])

  const sendStageContent = useCallback(async (content: string): Promise<boolean> => {
    if (!token || phase.kind !== 'ready' || !task) return false
    const selectedTargetReady = chatTarget !== 'coordinator' && (
      runningStages.some((stage) => stage.key === chatTarget)
      || resumableStages.some((stage) => stage.key === chatTarget)
    )
    const target = selectedTargetReady
      ? chatTarget
      : runningStages[0]?.key || resumableStages[0]?.key
    if (!target) {
      setChatError(t('share.noInteractiveStage'))
      return false
    }
    setChatError('')
    try {
      const stageProgressItem = stageProgress.find((item) => item.step_key === target)
      const canResume = stageProgressItem
        && isStageResumableWithMessage(
          stageProgressItem.status,
          stageProgressItem.has_history,
        )
      const accepted = canResume
        ? await shareApi.resumeStage(token, phase.sessionToken, target, content)
        : await shareApi.sendStageMessage(
            token,
            phase.sessionToken,
            task.id,
            target,
            content,
          )
      setMessages((current) => [
        ...current,
        createOptimisticUserMessage(
          accepted.message_id,
          content,
          target,
          accepted.created_at || new Date().toISOString(),
        ),
      ])
      await refreshSharedTask(phase.sessionToken)
      return true
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      return false
    }
  }, [
    token,
    phase,
    task,
    chatTarget,
    stageProgress,
    runningStages,
    resumableStages,
    t,
    refreshSharedTask,
  ])

  const handleSend = useCallback(async () => {
    const content = prompt.trim()
    if (!content) return
    const sent = await sendStageContent(content)
    if (sent) setPrompt('')
  }, [prompt, sendStageContent])

  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    const content = t(
      'taskDetail.a2uiActionMessage',
      a2uiActionMessageParams(action),
    )
    void sendStageContent(content)
  }, [sendStageContent, t])

  const handleStopStage = useCallback(async (stepKey: string) => {
    if (!token || phase.kind !== 'ready') return
    if (stoppingStepKeys.includes(stepKey)) return
    setStoppingStepKeys((current) => [...current, stepKey])
    setChatError('')
    try {
      await shareApi.cancelStage(token, phase.sessionToken, stepKey)
      await refreshSharedTask(phase.sessionToken)
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setStoppingStepKeys((current) => current.filter((key) => key !== stepKey))
    }
  }, [
    token,
    phase,
    stoppingStepKeys,
    t,
    refreshSharedTask,
  ])

  const handleReviewAction = useCallback(async (
    decision: 'approve' | 'reject' | 'force-approve',
    review?: ReviewRun,
    stepKey?: string,
  ) => {
    if (!token || phase.kind !== 'ready' || !review || !stepKey) return
    setReviewActionPending(true)
    setChatError('')
    try {
      await shareApi.decideReview(
        token,
        phase.sessionToken,
        stepKey,
        review.id,
        decision,
        reviewComment.trim() || undefined,
      )
      setReviewComment('')
      const [reviewsData] = await Promise.all([
        shareApi.reviews(token, phase.sessionToken),
        refreshSharedTask(phase.sessionToken),
      ])
      setReviews(reviewsData.reviews || [])
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('common.unknownError'))
    } finally {
      setReviewActionPending(false)
    }
  }, [
    token,
    phase,
    reviewComment,
    t,
    refreshSharedTask,
  ])

  const handleInteractionRespond = useCallback(async (
    interactionId: string,
    response: Record<string, unknown>,
  ) => {
    if (!token || phase.kind !== 'ready') return
    await shareApi.respondInteraction(
      token,
      phase.sessionToken,
      interactionId,
      response,
    )
  }, [token, phase])

  const findArtifact = (
    name: string,
    preferredStepKey?: string,
    source?: TaskArtifact[],
  ) => {
    return findPreferredArtifact(source || artifacts, name, preferredStepKey)
  }

  const openArtifact = (name: string, preferredStepKey?: string) => {
    const artifact = findArtifact(name, preferredStepKey)
    if (artifact) {
      setPreviewArtifact(artifact)
    } else {
      setArtifactNotice(t('taskDetail.artifactNotFound', { name }))
      window.setTimeout(() => setArtifactNotice(null), 3000)
    }
  }

  // 底部主操作与 owner 弹窗共用同一状态机；分享页只开放可交互分享的推进动作。
  const taskNotStarted = isTaskNotStarted(task?.steps || [])
  const activeStageProgress = stageProgress[activeStageIndex]
  const activeStepStatus = activeStageProgress?.status || 'pending'
  const activeReview = reviews.find(
    (review) => review.step_key === activeStage.key,
  )
  const shareAdvanceState = resolveTaskDetailAdvanceState({
    taskNotStarted,
    running: false,
    taskStatus: task?.status,
    stepStates: task?.steps || [],
    activeStepStatus,
    reviewActionPending,
    hasActiveReview: Boolean(activeReview),
    t,
  })
  const handleShareAdvance = () => {
    if (!interactive || !activeReview) return
    if (activeStepStatus === 'awaiting_review') {
      void handleReviewAction('approve', activeReview, activeStage.key)
    } else if (activeStepStatus === 'rejected') {
      void handleReviewAction('force-approve', activeReview, activeStage.key)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  if (!token) {
    return (
      <SharePageShell>
        <p style={{ color: 'var(--danger)' }}>{t('share.shareNotFound')}</p>
      </SharePageShell>
    )
  }

  if (phase.kind === 'loading-meta') {
    return (
      <SharePageShell>
        <LoadingHint>{t('common.loading')}</LoadingHint>
      </SharePageShell>
    )
  }

  if (phase.kind === 'error') {
    return (
      <SharePageShell>
        <div
          style={{
            padding: '32px 24px',
            textAlign: 'center',
            color: 'var(--danger)',
            fontSize: 'calc(14px * var(--font-scale))',
          }}
        >
          {phase.message || t('share.shareNotFound')}
        </div>
      </SharePageShell>
    )
  }

  if (phase.kind === 'need-password' || phase.kind === 'unlocking') {
    const unlocking = phase.kind === 'unlocking'
    const m = phase.meta
    return (
      <SharePageShell>
        <div
          style={{
            width: 360,
            maxWidth: '90vw',
            margin: '48px auto',
            padding: '24px 28px',
            background: 'var(--bg)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--elev-raised), 0 0 0 1px var(--border-soft)',
          }}
        >
          <div style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 600, marginBottom: 6 }}>
            {t('share.enterPassword')}
          </div>
          <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)', marginBottom: 16 }}>
            {m.title || t('share.viewerSubtitle', { title: t('share.viewerTitle') })}
          </div>
          <Input
            type="password"
            value={password}
            autoFocus
            disabled={unlocking}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('share.passwordPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !unlocking) handleUnlock()
            }}
            style={{ marginBottom: 12 }}
          />
          {error && (
            <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)', marginBottom: 8 }}>
              {error}
            </div>
          )}
          <Button
            variant="primary"
            loading={unlocking}
            onClick={handleUnlock}
            style={{ width: '100%', fontSize: 'calc(13px * var(--font-scale))', justifyContent: 'center' }}
          >
            {unlocking ? t('share.unlocking') : t('share.unlock')}
          </Button>
        </div>
      </SharePageShell>
    )
  }

  if (!task) {
    return (
      <SharePageShell>
        <LoadingHint>{t('share.shareLoading')}</LoadingHint>
      </SharePageShell>
    )
  }

  const wsLabel =
    wsStatus === 'live'
      ? t('share.live')
      : wsStatus === 'connecting'
        ? t('share.connecting')
        : t('share.disconnected')
  const wsColor =
    wsStatus === 'live'
      ? 'var(--success)'
      : wsStatus === 'connecting'
        ? 'var(--warning, var(--meta))'
        : 'var(--danger, var(--meta))'

  const headerActions = (
    <>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 'calc(11px * var(--font-scale))',
          color: wsColor,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: wsColor,
            boxShadow:
              wsStatus === 'live'
                ? `0 0 0 3px color-mix(in oklab, ${wsColor}, transparent 75%)`
                : 'none',
          }}
        />
        {wsLabel}
      </span>
    </>
  )

  const canAdvanceReview = interactive
    && (activeStepStatus === 'awaiting_review' || activeStepStatus === 'rejected')
  const sharePrimaryAction = canAdvanceReview
    ? {
        label: shareAdvanceState.label,
        disabled: shareAdvanceState.disabled,
        loading: reviewActionPending,
        onClick: handleShareAdvance,
      }
    : undefined

  return (
    <SharePageShell>
      <TaskDetailPage
        readOnly={!interactive}
        interactionOnly={interactive}
        task={task}
        stages={stages}
        stageProgress={stageProgress}
        selectedStage={selectedStage}
        onStageClick={setSelectedStage}
        historyMessages={messages}
        liveMessages={{}}
        events={[]}
        content=""
        reviews={reviews}
        reviewActionPending={reviewActionPending}
        reviewComment={reviewComment}
        onReviewCommentChange={setReviewComment}
        onReviewAction={interactive ? handleReviewAction : undefined}
        chatTarget={chatTarget}
        onChatTargetChange={setChatTarget}
        chatError={chatError}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={interactive ? handleSend : undefined}
        onStopStage={interactive ? handleStopStage : undefined}
        stoppingStepKeys={stoppingStepKeys}
        onA2uiAction={interactive ? handleA2uiAction : undefined}
        onInteractionRespond={interactive ? handleInteractionRespond : undefined}
        artifacts={artifacts}
        onOpenArtifact={openArtifact}
        headerActions={headerActions}
        locale={locale}
        durationNowMs={durationNowMs}
        currentStage={currentStage}
        activeStage={activeStage}
        currentStageColor={currentStageColor}
        activeStageColor={activeStageColor}
        taskCompleted={taskCompleted}
        runningStages={interactive ? runningStages : []}
        executionStageModel={executionStageModel}
        sessionIdForStep={() => null}
        onViewingPromptChange={() => {}}
        running={task.status === 'running'}
        primaryAction={sharePrimaryAction}
        previewArtifact={previewArtifact}
        onCloseArtifactPreview={() => setPreviewArtifact(null)}
        artifactNotice={artifactNotice || undefined}
      />
    </SharePageShell>
  )
}

function SharePageShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-app, var(--bg))',
        color: 'var(--fg)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  )
}

function LoadingHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--muted)',
        fontSize: 'calc(13px * var(--font-scale))',
      }}
    >
      <Spinner size={14} />
      {children}
    </div>
  )
}
