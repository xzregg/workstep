import { useTaskHistory } from '../hooks/useTaskHistory'
import { useTaskCoordinatorConfig } from '../hooks/useTaskCoordinatorConfig'
import { useTaskStepControls } from '../hooks/useTaskStepControls'
import { gitApi } from '../api/git'
import { useSearchParams } from 'react-router-dom'
import { useTaskRoute } from '../hooks/useTaskRoute'
import { randomUuid } from '../utils/uuid'
import Button from '../components/Button'
import TaskDetailWindow from '../components/TaskDetailWindow'
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import { useTaskStore, type LiveMessage } from '../stores/taskStore'
import { useProjectStore } from '../stores/projectStore'
import {
  fsApi,
  taskApi,
  type ActionProposal,
  type TaskStepState,
} from '../api/client'
import { copyMessageText } from '../components/MessageResponseFooter'
import { a2uiActionMessageParams } from '../utils/a2ui'
import StepPromptEditor from '../components/StepPromptEditor'
import Icon from '../components/Icon'
import ShareDialog from '../components/ShareDialog'
import TaskDiscussionGroups from '../components/TaskDiscussionGroups'
import ConfirmDialog from '../components/ConfirmDialog'
import TaskDetailPage, { type TaskDetailReadCapabilities } from '../components/TaskDetailPage'
import { resolveMarkdownImageSrc } from '../utils/markdownImages'
import TaskStepConfigController from '../components/TaskStepConfigController'
import {
  createOptimisticCoordinatorMessage,
  createOptimisticUserMessage,
  resolveTaskChatTarget,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isStepResumableWithMessage,
  isStepActiveForStop,
  resolveStepDisplayStatus,
  runningTaskMessageIds,
  findActiveStepIndex,
  findLatestDispatchedTask,
  resolveStepRestartImpact,
} from './taskDetailChat'
import { mergeRefreshedTaskHistory } from './taskHistoryModel'
import { useTaskArtifacts } from '../hooks/useTaskArtifacts'
import { useTaskReviewActions } from '../hooks/useTaskReviewActions'
import { useTaskPendingInserts } from '../hooks/useTaskPendingInserts'
import { CUSTOM } from '../utils/agui'
import { useI18n } from '../i18n'

const EMPTY_EVENTS: any[] = []
const EMPTY_LIVE_MESSAGES: Record<string, LiveMessage> = {}

type StepVisualState =
  | 'completed'
  | 'current'
  | 'reviewing'
  | 'awaiting_review'
  | 'retrying'
  | 'rework'
  | 'rework_waiting'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'pending'

interface StepData {
  key: string
  label: string
  color: string
  kind?: 'llm' | 'task_dispatch'
  dispatch?: {
    targetProjectId?: string
    targetWorkflowId?: string
    targetStartStepKey?: string
  }
  nodeId?: string | number
  dependsOn?: string[]
  reworkDependsOn?: string[]
  engine?: string
  model?: string
  config?: Record<string, string>
  prompt: string
  inputs: Array<{
    name: string
    type: string
    outputs?: Array<{ name: string; type: string }>
  }>
  outputs: Array<{ name: string; type: string }>
}

interface StepProgress extends Partial<TaskStepState> {
  visualState: StepVisualState
}

interface TaskDetailProps {
  taskId: string
  onClose: () => void
}

const TASK_HISTORY_PAGE_SIZE = 300

export default function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const { t, locale } = useI18n()
  const { openTask } = useTaskRoute()
  const activeProject = useProjectStore((s) => s.activeProject)
  const projects = useProjectStore((s) => s.projects)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const [searchParams] = useSearchParams()
  const urlProjectName = searchParams.get('project')
  // Resolve the project this task belongs to: prefer the URL ?project= hint
  // (set when the task was opened) so the panel stays pinned to the correct
  // project even if global activeProject changes mid-session.
  // When the resolved project IS the active project, use activeProject directly
  // because its `steps` are kept fresh by setActiveWorkflow, while the
  // projects[] entry may hold stale steps from the last fetchProjects.
  const detailProject = useMemo(() => {
    if (urlProjectName) {
      const match = projects.find((p) => p.name === urlProjectName)
      if (match) {
        if (activeProject?.id === match.id) return activeProject
        return match
      }
    }
    return activeProject
  }, [urlProjectName, projects, activeProject])
  const tasks = useTaskStore((s) => s.tasks)
  const events = useTaskStore((s) => (taskId ? s.events[taskId] : undefined) ?? EMPTY_EVENTS)
  const content = useTaskStore((s) => (taskId ? s.content[taskId] : '') ?? '')
  const liveMessages = useTaskStore((s) => (
    taskId ? s.liveMessages[taskId] : undefined
  ) ?? EMPTY_LIVE_MESSAGES)
  const userMessageEvents = useTaskStore((s) => (
    taskId ? (s.userMessageEvents[taskId] ?? 0) : 0
  ))
  const availableCommands = useTaskStore((s) => (
    taskId ? s.availableCommands[taskId] : undefined
  ))
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const refreshTask = useTaskStore((s) => s.refreshTask)

  const projectId = detailProject?.id || ''
  const ownerFilePreview = useMemo(() => ({
    load: (path: string) => fsApi.preview(path, projectId),
    rawUrl: (path: string) => fsApi.projectFileUrl(path, projectId),
  }), [projectId])
  const ownerAssetUrl = useCallback(
    (src: string) => resolveMarkdownImageSrc(src, projectId),
    [projectId],
  )
  const ownerExecutionReport = useCallback(
    () => taskApi.executionReport(taskId, projectId),
    [taskId, projectId],
  )
  const task = tasks.find((t) => t.id === taskId)
  const taskStatus = task?.status
  const taskCompleted = isTaskCompleted(task?.steps || [])
  const sessionIdForStep = (stepKey?: string | null): string | null => {
    if (!stepKey) return null
    const step = (task?.steps || []).find((item) => item.step_key === stepKey)
    return step?.session_id || null
  }
  const reviewEventSignal = useMemo(() => {
    // 实时链路是 AG-UI 事件：审核生命周期信号以 CUSTOM workstep.* 出现，
    // 审核消息内容由后端在持久化后以 channel=review 的消息事件推送。
    const customEvent = [...events].reverse().find((item) =>
      item.type === 'CUSTOM' && (
        item.name === CUSTOM.reviewStatus
        || item.name === CUSTOM.reviewResult
        || item.name === CUSTOM.stepRetrying
      )
    )
    if (customEvent) {
      const value = customEvent.value ?? customEvent.data ?? {}
      return `custom:${customEvent.name}:${value.review_run_id || ''}:${value.status || ''}:${value.attempt || ''}`
    }
    // 审核消息一开始就先补拉一次历史：即使错过了 TEXT_MESSAGE_START，
    // 已落库的「审核中」消息也能出现在任务消息列表里。
    const liveReview = Object.values(liveMessages).find(
      (message) => message.channel === 'review'
        && ['running', 'completed', 'succeeded', 'failed', 'cancelled'].includes(message.status),
    )
    return liveReview
      ? `review-message:${liveReview.id}:${liveReview.status}`
      : ''
  }, [events, liveMessages])
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (!taskId || !projectId) return
    void refreshTask(taskId, projectId).catch(() => undefined)
  }, [projectId, refreshTask, taskId])
  const [running, setRunning] = useState(false)
  const [coordinatorRunning, setCoordinatorRunning] = useState(false)
  const [chatTarget, setChatTarget] = useState<string | 'coordinator'>('coordinator')
  const [chatError, setChatError] = useState('')
  const [coordinatorStopping, setCoordinatorStopping] = useState(false)
  const [stepResuming, setStepResuming] = useState(false)
  const [resetStep, setResetStep] = useState(false)
  const [pendingStepRestart, setPendingStepRestart] = useState<{
    prompt: string
    targetStep: StepData
    resetSession: boolean
    interruptedSteps: StepData[]
    restartedSteps: StepData[]
    cancelledSteps: StepData[]
  } | null>(null)
  const [activeCoordinatorMessageId, setActiveCoordinatorMessageId] = useState<string | null>(null)

  useEffect(() => {
    setResetStep(false)
  }, [chatTarget, taskId])
  const {
    config: coordinatorConfig,
    providers,
    saving: coordinatorConfigSaving,
    error: coordinatorConfigError,
    notice: coordinatorConfigNotice,
    onEngineChange: handleCoordinatorEngineChange,
    onProviderChange: handleCoordinatorProviderChange,
    onModelChange: handleCoordinatorModelChange,
    onFastModelChange: handleCoordinatorFastModelChange,
    onVisionModelChange: handleCoordinatorVisionModelChange,
    onThinkingEffortChange: handleCoordinatorThinkingEffortChange,
  } = useTaskCoordinatorConfig(taskId, projectId)
  const [proposalOverrides, setProposalOverrides] = useState<Record<string, ActionProposal>>({})
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [livePromptOverrides, setLivePromptOverrides] = useState<Record<string, string>>({})
  const [taskIdCopied, setTaskIdCopied] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [discussionGroupsOpen, setDiscussionGroupsOpen] = useState(false)
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  const [selectedStep, setSelectedStep] = useState(0)
  const selectedStepTaskRef = useRef<string | null>(null)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const shouldFollowMessagesRef = useRef(true)
  const lastProgrammaticScrollTopRef = useRef(0)
  const stepLastMessageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const pendingStepScrollRef = useRef<string | null>(null)
  const { historyMessages, setHistoryMessages, historyLoading,
    loadOlderHistory, loadMessageEvents } = useTaskHistory({
    taskId, projectId, userMessageEvents, reviewEventSignal,
    chatScrollRef, shouldFollowMessagesRef, lastProgrammaticScrollTopRef,
  })
  const {
    stoppingStepKeys, restartingStepKeys, retryingFailedMessageIds,
    stopStep: handleStopStep,
    restartStepWithFreshSession: handleRestartStepWithFreshSession,
    retryFailedMessage: handleRetryFailedMessage,
  } = useTaskStepControls({
    taskId, projectId,
    onError: setChatError,
    onFollow: () => { shouldFollowMessagesRef.current = true },
    onHistoryRefresh: (messages) => setHistoryMessages((current) =>
      mergeRefreshedTaskHistory(current, messages)),
  })
  const {
    artifacts, artifactDirectory, inputSnapshots: artifactInputSnapshots,
    previewArtifact, closePreview: closeArtifactPreview, notice: artifactNotice,
    openArtifact, openArtifactDirectory,
  } = useTaskArtifacts({ taskId, projectId, steps: task?.steps, remote: detailProject?.type === 'remote' })
  const {
    reviews, pending: reviewActionPending, pendingCompletion: pendingReviewCompletion,
    reviewComment, setReviewComment, decideReview,
    requestFailedExecutionComplete, confirmCompletion, cancelCompletion,
  } = useTaskReviewActions({
    taskId, projectId, updatedAt: task?.updated_at, reviewEventSignal,
    fetchTasks, refreshTask, onError: setChatError,
  })
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const persistedMessageIds = useMemo(
    () => new Set(historyMessages.map((message) => String(message.id))),
    [historyMessages],
  )
  const liveExecutionMessages = useMemo(
    () => Object.values(liveMessages).filter(
      (message) => isVisibleLiveExecutionMessage(message)
        && isUnpersistedLiveMessage(message, persistedMessageIds),
    ),
    [liveMessages, persistedMessageIds],
  )
  const missingLivePromptIds = useMemo(
    () => liveExecutionMessages
      .filter((message) => !message.prompt && !livePromptOverrides[message.id])
      .map((message) => message.id)
      .sort(),
    [liveExecutionMessages, livePromptOverrides],
  )

  useEffect(() => {
    if (!taskId || !projectId || missingLivePromptIds.length === 0) return
    let cancelled = false
    const missingIds = new Set(missingLivePromptIds)
    taskApi.history(taskId, projectId, TASK_HISTORY_PAGE_SIZE, 0)
      .then((response) => {
        if (cancelled) return
        const prompts = Object.fromEntries(
          (response.messages || [])
            .filter((message: any) => missingIds.has(String(message.id)) && message.prompt)
            .map((message: any) => [String(message.id), String(message.prompt)]),
        )
        if (Object.keys(prompts).length > 0) {
          setLivePromptOverrides((current) => ({ ...current, ...prompts }))
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [missingLivePromptIds.join('|'), projectId, taskId])

  // Fetch tasks if not already loaded
  useEffect(() => {
    if (tasks.length === 0 && projectId) fetchTasks(projectId)
  }, [tasks.length, fetchTasks, projectId])

  useEffect(() => {
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
  }, [taskId])

  useEffect(() => {
    if (!activeCoordinatorMessageId) return
    const activeMessage = liveMessages[activeCoordinatorMessageId]
    if (!activeMessage || !['succeeded', 'failed', 'stopped'].includes(activeMessage.status)) return
    setCoordinatorRunning(false)
    setActiveCoordinatorMessageId(null)
    if (taskId && projectId) {
      taskApi.history(taskId, projectId)
        .then((res) => setHistoryMessages((current) => (
          mergeRefreshedTaskHistory(current, res.messages || [])
        )))
        .catch(() => undefined)
    }
  }, [activeCoordinatorMessageId, liveMessages, projectId, taskId])

  useEffect(() => {
    if (historyLoading || !pendingStepScrollRef.current) return
    const stepKey = pendingStepScrollRef.current
    const frame = requestAnimationFrame(() => {
      stepLastMessageRefs.current[stepKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStepScrollRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [historyLoading, historyMessages])

  useEffect(() => {
    if (taskStatus) setRunning(taskStatus === 'running')
  }, [taskStatus])

  // Get steps from project steps
  const steps = useMemo<StepData[]>(() => {
    const steps = detailProject?.steps
    if (steps?.nodes?.length) {
      const nodes = steps.nodes as any[]
      const keyByNodeId = new Map<string, string>()
      nodes.forEach((node, index) => {
        keyByNodeId.set(
          String(node.id ?? index + 1),
          String(node.type || node.key || node.id || `step-${index + 1}`),
        )
      })
      const dependsByKey = new Map<string, string[]>()
      const reworkDependsByKey = new Map<string, string[]>()
      const rawConnections = Array.isArray(steps.connections)
        ? steps.connections
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
      return nodes.map((node: any, index: number) => {
        const key = String(node.type || node.key || node.id || `step-${index + 1}`)
        return {
          key,
          nodeId: node.id ?? index + 1,
          label: node.title || node.label || key,
          color: node.color || 'var(--meta)',
          kind: node.kind === 'task_dispatch' ? 'task_dispatch' : 'llm',
          dispatch: node.dispatch,
          dependsOn: dependsByKey.get(key) ?? [],
          reworkDependsOn: reworkDependsByKey.get(key) ?? [],
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
        }
      })
    }
    if (steps?.steps?.length) return steps.steps.map((s: any) => ({
      key: s.key || s.id,
      label: s.label || s.name,
      color: s.color || 'var(--meta)',
      kind: s.kind === 'task_dispatch' ? 'task_dispatch' : 'llm',
      dispatch: s.dispatch,
      dependsOn: s.dependsOn || [],
      reworkDependsOn: s.reworkDependsOn || [],
      engine: s.engine || '',
      model: s.model || '',
      prompt: s.prompt || '',
      config: s.config || {},
      inputs: (s.inputs || []).map((i: any) => ({
        name: i.name || i,
        type: i.type || 'any',
        outputs: i.outputs || [],
      })),
      outputs: (s.outputs || []).map((o: any) => ({
        name: o.name || o,
        type: o.type || 'any',
      })),
    }))
    return [{ key: 'do', label: t('taskList.execute'), color: 'var(--accent)', engine: '', model: '', prompt: '', inputs: [], outputs: [] }]
  }, [detailProject?.steps, t])

  const stepProgress = useMemo<StepProgress[]>(() => {
    const stepByKey = new Map(
      (task?.steps || []).map((step) => [step.step_key, step]),
    )
    const rawStatuses: TaskStepState['status'][] = steps.map((definition: any) => {
      const taskStep = stepByKey.get(definition.key)
      return resolveStepDisplayStatus(
        taskStep?.status || 'pending',
        taskStep?.previous_status,
      ) as TaskStepState['status']
    })
    const activeIndex = findActiveStepIndex(rawStatuses, task?.status)

    return steps.map((definition, index) => {
      const taskStep = stepByKey.get(definition.key)
      const status = rawStatuses[index]
      let visualState: StepVisualState = 'pending'
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
      return { ...taskStep, visualState }
    })
  }, [steps, task?.status, task?.steps])

  const activeStepIndex = useMemo(() => {
    const current = stepProgress.findIndex((progress: StepProgress) =>
      ['current', 'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting'].includes(
        progress.visualState
      )
    )
    if (current >= 0) return current
    const failed = stepProgress.findIndex((progress: StepProgress) =>
      progress.visualState === 'failed'
    )
    if (failed >= 0) return failed
    const restartTarget = steps.findIndex((step) =>
      step.key === task?.restart_from_step_key
    )
    if (restartTarget >= 0) return restartTarget
    for (let index = stepProgress.length - 1; index >= 0; index -= 1) {
      if (stepProgress[index].visualState !== 'pending') return index
    }
    return 0
  }, [stepProgress, steps, task?.restart_from_step_key])

  const currentStep = steps[selectedStep] || steps[0]
  const activeStep = steps[activeStepIndex] || steps[0]
  const executionStepModel = activeStep?.model || task?.model || ''

  useEffect(() => {
    if (!task?.id) return
    if (selectedStepTaskRef.current !== task.id) selectedStepTaskRef.current = task.id
    setSelectedStep(activeStepIndex)
  }, [activeStepIndex, task?.id])

  const shouldTickDuration = coordinatorRunning
    || Boolean(activeCoordinatorMessageId)
    || taskStatus === 'running' || stepProgress.some(
    (progress) => [
      'reviewing', 'awaiting_review', 'retrying', 'rework', 'rework_waiting',
    ].includes(progress.visualState)
  )

  useEffect(() => {
    if (!shouldTickDuration) return
    setDurationNowMs(Date.now())
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [shouldTickDuration])

  const runningSteps = useMemo(() => {
    const runningKeys = new Set(
      stepProgress
        .filter((progress) => isStepActiveForStop(progress.status))
        .map((progress) => progress.step_key),
    )
    return steps.filter((step) => runningKeys.has(step.key))
  }, [steps, stepProgress])

  const resumableSteps = useMemo(() => {
    const resumableKeys = new Set(
      stepProgress
        .filter((progress) => (
          isStepResumableWithMessage(progress.status, progress.has_history)
        ))
        .map((progress) => progress.step_key),
    )
    return steps.filter((step) => resumableKeys.has(step.key))
  }, [steps, stepProgress])

  const chatTargetStepKey = chatTarget === 'coordinator' ? null : chatTarget
  const chatTargetStep = chatTargetStepKey !== null
  const targetStep = chatTargetStepKey
    ? (runningSteps.find((step) => step.key === chatTargetStepKey)
      ?? resumableSteps.find((step) => step.key === chatTargetStepKey)
      ?? null)
    : null
  const activeStepRunning = targetStep !== null
    && runningSteps.some((step) => step.key === targetStep.key)
  const runningMessageByChannel = useMemo(
    () => runningTaskMessageIds(historyMessages, liveMessages, targetStep?.key ?? null),
    [historyMessages, liveMessages, targetStep?.key],
  )
  const coordinatorMessageId = coordinatorRunning && activeCoordinatorMessageId
    ? activeCoordinatorMessageId
    : runningMessageByChannel.coordinator || null
  const coordinatorIsRunning = coordinatorRunning || Boolean(coordinatorMessageId)
  const pendingTargetMessageId = chatTarget === 'coordinator'
    ? coordinatorMessageId
    : (activeStepRunning
      ? (stepProgress.some((progress) => (
          progress.step_key === targetStep?.key && progress.status === 'reviewing'
        ))
          ? runningMessageByChannel.review
          : runningMessageByChannel.execution) || null
      : null)
  const pendingInserts = useTaskPendingInserts({
    taskId, projectId, targetMessageId: pendingTargetMessageId,
    channel: chatTarget === 'coordinator' ? 'coordinator' : 'step',
    targetStepKey: targetStep?.key ?? null, activeStepKey: activeStep.key,
    stepRunning: activeStepRunning, setHistoryMessages,
    onCoordinatorRunning: setCoordinatorRunning,
    onCoordinatorAccepted: setActiveCoordinatorMessageId,
    onFollow: () => {
      shouldFollowMessagesRef.current = true
      setHasUnreadMessages(false)
    },
    onError: setChatError,
  })

  // When a step engine starts, the input switches to the matching step tab
  // for direct insert-into-execution messages; when no step is running the
  // tab stays on a stopped/failed step so a message can re-run it; otherwise
  // it returns to the coordinator. Manual user selection is preserved.
  useEffect(() => {
    setChatTarget((current) => {
      if (runningSteps.length === 0) {
        return resolveTaskChatTarget(
          current,
          [],
          resumableSteps.map((step) => step.key),
        )
      }
      return resolveTaskChatTarget(
        current,
        runningSteps.map((step) => step.key),
        [],
      )
    })
  }, [runningSteps, resumableSteps])

  /** 向当前可恢复步骤发送一条消息并重新执行该步骤（step 模式的新 turn）。 */
  const resumeStepWithPrompt = useCallback(async (
    promptText: string,
    opts?: {
      onErrorRestore?: () => void
      targetStep?: StepData
      resetSession?: boolean
    },
  ): Promise<boolean> => {
    const resumeTarget = opts?.targetStep ?? targetStep
    if (!taskId || !projectId || !resumeTarget) return false
    setChatError('')
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticUserMessage(
      optimisticId,
      promptText,
      resumeTarget.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setHistoryMessages((current) => [...current, optimisticMessage])
    setStepResuming(true)
    try {
      const accepted = await taskApi.resumeStepWithMessage(
        taskId,
        resumeTarget.key,
        promptText,
        projectId,
        Boolean(opts?.resetSession),
      )
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.message_id,
              run_id: accepted.run_id,
              channel: 'execution',
              run_status: 'completed',
              sequence: accepted.sequence,
              created_at: accepted.created_at || message.created_at,
            }
          : message
      )))
      if (opts?.resetSession) setResetStep(false)
      return true
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      opts?.onErrorRestore?.()
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      return false
    } finally {
      setStepResuming(false)
    }
  }, [taskId, projectId, targetStep, t])

  const handleRun = async (contentOverride?: string) => {
    if (!taskId || !projectId) return
    const submittedPrompt = (contentOverride ?? prompt).trim()
    if (!submittedPrompt) return
    if ((chatTargetStep && activeStepRunning) || (!chatTargetStep && coordinatorIsRunning)) {
      if (!pendingTargetMessageId) return
      setChatError('')
      if (await pendingInserts.add(submittedPrompt)) setPrompt('')
      return
    }
    // Step mode (Codex-like): while the step runs, sends land in the
    // pending-insert table; after completion the backend merges and runs them.
    // After a manual stop, sending persists the message and re-runs the step.
    if (chatTargetStep) {
      if (stepResuming) return
      if (!targetStep) return
      const impact = resolveStepRestartImpact(
        steps,
        stepProgress,
        targetStep.key,
      )
      if (impact.interrupted.length > 0) {
        setPendingStepRestart({
          prompt: submittedPrompt,
          targetStep,
          resetSession: resetStep,
          interruptedSteps: impact.interrupted,
          restartedSteps: impact.restarted,
          cancelledSteps: impact.cancelled,
        })
        return
      }
      setPrompt('')
      await resumeStepWithPrompt(submittedPrompt, {
        onErrorRestore: () => setPrompt(submittedPrompt),
        resetSession: resetStep,
      })
      return
    }
    shouldFollowMessagesRef.current = true
    const optimisticId = `pending-${randomUuid()}`
    const optimisticMessage = createOptimisticCoordinatorMessage(
      optimisticId,
      submittedPrompt,
      activeStep.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setChatError('')
    setHistoryMessages((current) => [...current, optimisticMessage])
    setPrompt('')
    setCoordinatorRunning(true)
    try {
      const accepted = await taskApi.chat(
        taskId,
        submittedPrompt,
        projectId,
        randomUuid(),
        [],
        resetStep,
      )
      setHistoryMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              id: accepted.user_message_id,
              channel: 'coordinator',
              run_status: 'completed',
            }
          : message
      )))
      setActiveCoordinatorMessageId(accepted.assistant_message_id)
      if (resetStep) setResetStep(false)
    } catch (reason) {
      setHistoryMessages((current) => current.filter(
        (message) => message.id !== optimisticId
      ))
      setPrompt(submittedPrompt)
      setCoordinatorRunning(false)
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
    }
  }

  const confirmUpstreamRestart = async () => {
    const pending = pendingStepRestart
    if (!pending || stepResuming) return
    setPrompt('')
    const accepted = await resumeStepWithPrompt(pending.prompt, {
      targetStep: pending.targetStep,
      resetSession: pending.resetSession,
      onErrorRestore: () => setPrompt(pending.prompt),
    })
    if (accepted) setPendingStepRestart(null)
  }

  const handleStopCoordinator = async () => {
    if (!taskId || !projectId || coordinatorStopping) return
    setCoordinatorStopping(true)
    setChatError('')
    try {
      await taskApi.stopCoordinator(taskId, projectId)
      setCoordinatorRunning(false)
      setActiveCoordinatorMessageId(null)
      taskApi.history(taskId, projectId)
        .then((res) => setHistoryMessages((current) => (
          mergeRefreshedTaskHistory(current, res.messages || [])
        )))
        .catch(() => undefined)
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setCoordinatorStopping(false)
    }
  }

  // A2UI protocol: clicks inside rendered UI bubbles (buttons, pickers, ...)
  // arrive as client actions. Relay them to the coordinator as a user message
  // so the model sees what the user selected and can continue the turn.
  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    if (!taskId || !projectId) return
    const content = t(
      'taskDetail.a2uiActionMessage',
      a2uiActionMessageParams(action),
    )
    const optimisticId = `pending-a2ui-${randomUuid()}`
    const optimisticMessage = createOptimisticCoordinatorMessage(
      optimisticId,
      content,
      activeStep.key,
      new Date().toISOString(),
    )
    shouldFollowMessagesRef.current = true
    setHasUnreadMessages(false)
    setChatError('')
    setHistoryMessages((current) => [...current, optimisticMessage])
    setCoordinatorRunning(true)
    taskApi.chat(taskId, content, projectId, randomUuid())
      .then((accepted) => {
        setHistoryMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? {
                ...message,
                id: accepted.user_message_id,
                channel: 'coordinator',
                run_status: 'completed',
              }
            : message
        )))
        setActiveCoordinatorMessageId(accepted.assistant_message_id)
      })
      .catch((reason) => {
        setHistoryMessages((current) => current.filter(
          (message) => message.id !== optimisticId
        ))
        setCoordinatorRunning(false)
        setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      })
  }, [taskId, projectId, activeStep, t])

  const handleInteractionRespond = useCallback(async (
    interactionId: string,
    response: Record<string, unknown>,
  ) => {
    await taskApi.respondInteraction(interactionId, response, projectId)
  }, [projectId])

  if (!task) {
    return (
      <div className="task-detail-not-found">
        {t('taskDetail.taskNotFound')}
        <br />
        <Button variant="ghost" className="task-detail-back" onClick={onClose}>← {t('common.back')}</Button>
      </div>
    )
  }

  const currentStepColor = currentStep.color || 'var(--accent)'
  const activeStepColor = activeStep.color || 'var(--accent)'
  const selectedReview = reviews.find((review) => review.step_key === currentStep.key)

  const handleStepClick = async (stepIndex: number) => {
    const clickedStep = steps[stepIndex]
    if (clickedStep?.kind === 'task_dispatch') {
      const targetProjectId = clickedStep.dispatch?.targetProjectId
      const targetWorkflowId = clickedStep.dispatch?.targetWorkflowId
      if (targetProjectId && targetWorkflowId) {
        try {
          const result = await taskApi.list(targetProjectId, targetWorkflowId)
          const dispatchedTask = findLatestDispatchedTask(
            result.tasks,
            taskId,
            clickedStep.key,
          )
          if (dispatchedTask) {
            const targetProject = projects.find((project) => project.id === targetProjectId)
            openTask(dispatchedTask.id, targetProject?.name, targetWorkflowId)
            return
          }
        } catch (error) {
          setChatError(
            error instanceof Error ? error.message : t('common.unknownError'),
          )
        }
      }
    }

    setSelectedStep(stepIndex)
    const stepKey = steps[stepIndex]?.key
    if (!stepKey) return

    pendingStepScrollRef.current = stepKey
    if (historyLoading) return

    requestAnimationFrame(() => {
      stepLastMessageRefs.current[stepKey]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
      pendingStepScrollRef.current = null
    })
  }

  return (
    <TaskDetailWindow title={task.title} onClose={onClose}>
      {(headerHandlers) => <TaskStepConfigController
        projectId={projectId || ''}
        taskId={task.id}
        stepKey={chatTargetStepKey}
        running={activeStepRunning}
      >
        {({ inputConfig: stepEngineConfig, loading: stepEngineConfigLoading, error: stepEngineConfigError }) => <TaskDetailPage
        {...headerHandlers}
        task={task}
        gitCapability={projectId && detailProject?.type !== 'remote' ? { api: gitApi, projectId } : undefined}
        steps={steps}
        workflowConnections={detailProject?.steps?.connections || []}
        stepProgress={stepProgress}
        selectedStep={selectedStep}
        onStepClick={handleStepClick}
        historyMessages={historyMessages}
        onLoadOlderHistory={loadOlderHistory}
        readCapabilities={{
          artifactDirectory,
          resolveAssetUrl: ownerAssetUrl,
          filePreview: ownerFilePreview,
          loadMessageEvents,
          openArtifact,
          loadExecutionReport: ownerExecutionReport,
        } satisfies TaskDetailReadCapabilities}
        liveMessages={liveMessages}
        livePromptOverrides={livePromptOverrides}
        availableCommands={availableCommands}
        events={events}
        content={content}
        reviews={reviews}
        reviewActionPending={reviewActionPending}
        reviewComment={reviewComment}
        onReviewCommentChange={setReviewComment}
        onReviewAction={(decision, review, stepKey) => {
          void decideReview(decision, review ?? selectedReview, stepKey ?? currentStep.key)
        }}
        artifacts={artifacts}
        artifactInputSnapshots={artifactInputSnapshots}
        chatTarget={chatTarget}
        onChatTargetChange={setChatTarget}
        coordinatorRunning={coordinatorIsRunning}
        coordinatorConfig={coordinatorConfig}
        stepEngineConfig={stepEngineConfig}
        stepEngineConfigLoading={stepEngineConfigLoading}
        stepEngineConfigError={stepEngineConfigError}
        chatError={chatError}
        onChatError={setChatError}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={handleRun}
        onSendPrompt={(value) => { void handleRun(value) }}
        onActionChanged={() => {
          if (!taskId || !projectId) return
          void taskApi.history(taskId, projectId).then((res) => setHistoryMessages((current) => (
            mergeRefreshedTaskHistory(current, res.messages || [])
          )))
        }}
        onStop={chatTarget !== 'coordinator' && activeStepRunning
          ? () => void handleStopStep(chatTarget)
          : handleStopCoordinator}
        stoppingStepKeys={stoppingStepKeys}
        stepResuming={stepResuming}
        resetStep={resetStep}
        onResetStepChange={setResetStep}
        onStopStep={handleStopStep}
        onRestartStepWithFreshSession={handleRestartStepWithFreshSession}
        restartingStepKeys={restartingStepKeys}
        onRetryFailedMessage={handleRetryFailedMessage}
        onSetFailedExecutionComplete={requestFailedExecutionComplete}
        retryingFailedMessageIds={retryingFailedMessageIds}
        chatInputRef={chatInputRef}
        stepInserts={pendingInserts.items}
        stepInsertSendingIds={pendingInserts.sendingIds}
        onStepInsertSend={(insert) => { void pendingInserts.send([insert]) }}
        onSendAllInserts={() => { void pendingInserts.send(pendingInserts.items) }}
        onStepInsertRemove={(insertId) => { void pendingInserts.remove(insertId) }}
        onStepInsertEditStart={pendingInserts.startEdit}
        onStepInsertEditSave={(insertId) => { void pendingInserts.saveEdit(insertId) }}
        onStepInsertEditCancel={pendingInserts.cancelEdit}
        editingInsertId={pendingInserts.editingId}
        editingInsertContent={pendingInserts.editingContent}
        onEditingInsertContentChange={pendingInserts.setEditingContent}
        onClearInserts={() => { void pendingInserts.clear() }}
        onStepInsertReorder={(fromIndex, toIndex) => { void pendingInserts.reorder(fromIndex, toIndex) }}
        onCoordinatorEngineChange={handleCoordinatorEngineChange}
        onCoordinatorProviderChange={handleCoordinatorProviderChange}
        providers={providers}
        onCoordinatorModelChange={handleCoordinatorModelChange}
        onCoordinatorFastModelChange={handleCoordinatorFastModelChange}
        onCoordinatorVisionModelChange={handleCoordinatorVisionModelChange}
        onCoordinatorThinkingEffortChange={handleCoordinatorThinkingEffortChange}
        coordinatorConfigSaving={coordinatorConfigSaving}
        coordinatorConfigError={coordinatorConfigError}
        coordinatorConfigNotice={coordinatorConfigNotice}
        coordinatorStopping={coordinatorStopping}
        descriptionEditable
        onOpenPromptEditor={() => setShowPromptEditor(true)}
        reviewConfigEditable
        onA2uiAction={handleA2uiAction}
        onInteractionRespond={handleInteractionRespond}
        proposalOverrides={proposalOverrides}
        onProposalOverride={(updated) => {
          setProposalOverrides((current) => ({ ...current, [updated.id]: updated }))
          if (!taskId || !projectId) return
          void taskApi.history(taskId, projectId).then((res) => setHistoryMessages((current) => (
            mergeRefreshedTaskHistory(current, res.messages || [])
          ))).catch(() => undefined)
        }}
        headerActions={
          <>
            <Button className="task-detail-discussion-button" variant="ghost"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); setDiscussionGroupsOpen(true) }}>
              {t('channelBot.discussionGroups')}
            </Button>
            <Button
              className="task-detail-share-button"
              variant="ghost"
              title={t('taskDetail.shareButtonTitle')}
              aria-label={t('taskDetail.shareButtonTitle')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                setShareOpen(true)
              }}
            >
              <Icon name="share" size={13} strokeWidth={1.75} />
              <span className="task-detail-share-label">{t('share.dialogTitle')}</span>
            </Button>
            <Button
              className="task-detail-id-button"
              data-copied={taskIdCopied}
              variant="ghost"
              title={`${t('taskDetail.copyTaskIdTitle')}：${task.id}`}
              aria-label={`${t('taskDetail.copyTaskIdAria')}：${task.id}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={async () => {
                await copyMessageText(task.id)
                setTaskIdCopied(true)
                window.setTimeout(() => setTaskIdCopied(false), 1500)
              }}
            >
              <span className="task-detail-id-marquee">
                <span className="task-detail-id-marquee-track">
                  {taskIdCopied ? t('common.copied') : `ID: ${task.id}`}
                </span>
              </span>
            </Button>
          </>
        }
        locale={locale}
        durationNowMs={durationNowMs}
        currentStep={currentStep}
        activeStep={activeStep}
        currentStepColor={currentStepColor}
        activeStepColor={activeStepColor}
        taskCompleted={taskCompleted}
        runningSteps={runningSteps}
        executionStepModel={executionStepModel}
        sessionIdForStep={sessionIdForStep}
        onViewingPromptChange={setViewingPrompt}
        running={running}
        projectId={projectId}
        previewArtifact={previewArtifact}
        onCloseArtifactPreview={closeArtifactPreview}
        onOpenArtifactDirectory={openArtifactDirectory}
        canOpenArtifactDirectory={detailProject?.type !== 'remote'}
        projectType={detailProject?.type}
        viewingPrompt={viewingPrompt}
        onCloseViewingPrompt={() => setViewingPrompt(null)}
        artifactNotice={artifactNotice}
        overlays={<>
          <TaskDiscussionGroups open={discussionGroupsOpen} projectId={projectId} taskId={taskId}
            onClose={() => setDiscussionGroupsOpen(false)} />
          <ConfirmDialog
            open={pendingReviewCompletion !== null}
            title={t('taskDetail.setStepCompleteTitle')}
            message={t('taskDetail.setStepCompleteMessage')}
            confirmText={t('taskDetail.setStepCompleteAndSchedule')}
            secondaryText={t('taskDetail.setStepCompleteOnly')}
            loading={reviewActionPending}
            secondaryDisabled={reviewActionPending}
            onCancel={cancelCompletion}
            onConfirm={() => { void confirmCompletion(true) }}
            onSecondary={() => { void confirmCompletion(false) }}
          />
          <ConfirmDialog
            open={pendingStepRestart !== null}
            title={t('taskDetail.restartImpactConfirmTitle')}
            message={pendingStepRestart
              ? t('taskDetail.restartImpactConfirmMessage', {
                  target: pendingStepRestart.targetStep.label,
                  active: pendingStepRestart.interruptedSteps
                    .map((step) => step.label)
                    .join('、'),
                  restarted: pendingStepRestart.restartedSteps.length > 0
                    ? pendingStepRestart.restartedSteps
                        .map((step) => step.label)
                        .join('、')
                    : t('taskDetail.restartImpactNoSteps'),
                  cancelled: pendingStepRestart.cancelledSteps.length > 0
                    ? pendingStepRestart.cancelledSteps
                        .map((step) => step.label)
                        .join('、')
                    : t('taskDetail.restartImpactNoSteps'),
                })
              : ''}
            confirmText={t('taskDetail.restartImpactConfirmAction')}
            danger
            loading={stepResuming}
            onCancel={() => {
              if (!stepResuming) setPendingStepRestart(null)
            }}
            onConfirm={() => void confirmUpstreamRestart()}
          />
          {showPromptEditor && <StepPromptEditor
            key={currentStep.key}
            project={detailProject}
            step={currentStep}
            projectId={projectId}
            onSaved={(nextSteps) => {
              if (detailProject) setActiveProject({ ...detailProject, steps: nextSteps })
            }}
            onClose={() => setShowPromptEditor(false)}
          />}
          <ShareDialog
            open={shareOpen && !!task}
            taskId={taskId}
            projectId={projectId}
            onClose={() => setShareOpen(false)}
          />
        </>}
        onClose={onClose}
        chatScrollRef={chatScrollRef}
        chatEndRef={chatEndRef}
        shouldFollowMessagesRef={shouldFollowMessagesRef}
        lastProgrammaticScrollTopRef={lastProgrammaticScrollTopRef}
        stepLastMessageRefs={stepLastMessageRefs}
        pendingStepScrollRef={pendingStepScrollRef}
        hasUnreadMessages={hasUnreadMessages}
        onUnreadMessagesChange={setHasUnreadMessages}
        />}
      </TaskStepConfigController>}
    </TaskDetailWindow>
  )
}
