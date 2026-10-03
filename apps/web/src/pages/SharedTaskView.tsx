import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import ConfirmDialog from '../components/ConfirmDialog'
import Button from '../components/Button'
import Input from '../components/Input'
import Spinner from '../components/Spinner'
import TaskDetailPage, { type TaskDetailReadCapabilities } from '../components/TaskDetailPage'
import { createGitApi } from '../api/git'
import type {
  StepData,
  StepProgress,
  StepVisualState,
} from '../components/TaskDetailView'
import {
  shareApi,
  type TaskArtifact,
} from '../api/client'
import {
  createOptimisticUserMessage,
  isStepResumableWithMessage,
  isStepActiveForStop,
  isTaskCompleted,
  resolveStepDisplayStatus,
  findActiveStepIndex,
} from './taskDetailChat'
import { findPreferredArtifact } from './taskArtifactRules'
import { useI18n } from '../i18n'
import type { ReviewDecisionAction } from '../components/ReviewDecisionActions'
import type { SharedTaskApi } from '../api/share'
import { useSharedTaskSession } from '../hooks/useSharedTaskSession'

export default function SharedTaskView({ api = shareApi }: { api?: SharedTaskApi }) {
  const { token } = useParams<{ token: string }>()
  const { t, locale } = useI18n()
  const {
    phase, meta, task, messages, artifacts, artifactDirectory, reviews, wsStatus, retry, loadOlderHistory, loadingOlder,
    password, setPassword, error, unlock: handleUnlock, refreshTask: refreshSharedTask,
    appendOptimisticMessage, loadMessageEvents,
  } = useSharedTaskSession(token, api)
  const [previewArtifact, setPreviewArtifact] = useState<TaskArtifact | null>(null)
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState(0)
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
  const [chatTarget, setChatTarget] = useState<string | 'coordinator'>('coordinator')
  const [prompt, setPrompt] = useState('')
  const [chatError, setChatError] = useState('')
  const [stoppingStepKeys, setStoppingStepKeys] = useState<string[]>([])
  const [reviewComment, setReviewComment] = useState('')
  const [reviewPending, setReviewPending] = useState(false)
  const [reviewConfirmation, setReviewConfirmation] = useState<{ action: ReviewDecisionAction; review: any; stepKey: string } | null>(null)
  const reviewBusy = useRef(false)
  const selectedStepTaskRef = useRef<string | null>(null)

  // ── Step data for TaskDetailView (read-only mode) ──────────────────
  // Prefer the workflow definition as the source of truth for step order
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

  const steps = useMemo<StepData[]>(() => {
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

  const stepProgress = useMemo<StepProgress[]>(() => {
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
      return resolveStepDisplayStatus(
        step?.status || 'pending',
        step?.previous_status,
      )
    })
    const activeIndex = findActiveStepIndex(rawStatuses, task?.status)
    return keys.map((key, index) => {
      const step = stepByKey.get(key)
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
      return { ...step, visualState }
    })
  }, [task?.status, task?.steps, workflowNodes])

  const activeStepIndex = useMemo(() => {
    const current = stepProgress.findIndex((progress: StepProgress) =>
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
    const failed = stepProgress.findIndex(
      (progress: StepProgress) => progress.visualState === 'failed',
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

  useEffect(() => {
    if (!task?.id || selectedStepTaskRef.current === task.id) return
    setSelectedStep(activeStepIndex)
    selectedStepTaskRef.current = task.id
  }, [activeStepIndex, task?.id])

  const shouldTickDuration =
    task?.status === 'running' ||
    stepProgress.some((progress) =>
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

  const currentStep =
    steps[selectedStep] ||
    steps[0] || {
      key: '',
      label: '',
      color: 'var(--accent)',
      prompt: '',
      inputs: [],
      outputs: [],
    }
  const activeStep = steps[activeStepIndex] || currentStep
  const currentStepColor = currentStep.color || 'var(--accent)'
  const activeStepColor = activeStep.color || 'var(--accent)'
  const executionStepModel = activeStep?.model || task?.model || ''
  const taskCompleted = isTaskCompleted(task?.steps || [])
  const interactive = meta?.mode === 'interactive'
  const reviewActionLabels: Record<ReviewDecisionAction, string> = {
    approve: t('taskDetail.approve'), reject: t('taskDetail.reject'),
    'force-approve': t('taskDetail.forceApprove'), terminate: t('taskDetail.terminate'),
    'complete-task': t('taskDetail.completeTask'), 'set-complete': t('taskDetail.setStepComplete'),
  }
  const shareSessionToken = phase.kind === 'ready' ? phase.sessionToken : ''
  const sharedGitApi = useMemo(() => createGitApi(<T,>(path: string, options?: RequestInit) =>
    api.gitRequest<T>(token || '', shareSessionToken, path, options),
  ), [api, token, shareSessionToken])
  const markdownUrlResolver = useCallback(
    (src: string) => token && shareSessionToken
      ? api.resolveAttachmentUrl(token, shareSessionToken, src)
      : src,
    [api, token, shareSessionToken],
  )
  const sharedFilePreview = useMemo(() => ({
    load: (path: string) => token && shareSessionToken
      ? api.previewFile(token, shareSessionToken, path)
      : Promise.reject(new Error(t('share.sessionExpired'))),
    rawUrl: (path: string) => token && shareSessionToken
      ? api.fileUrl(token, shareSessionToken, path)
      : '',
  }), [api, token, shareSessionToken, t])
  const browseGitWorkspace = useCallback(
    (path: string, includeHidden: boolean) => token && shareSessionToken
      ? api.browseGitWorkspace(token, shareSessionToken, path, includeHidden)
      : Promise.reject(new Error(t('share.sessionExpired'))),
    [api, token, shareSessionToken, t],
  )
  const executionReportLoader = useCallback(() => {
    if (!token || !shareSessionToken) {
      return Promise.reject(new Error(t('share.sessionExpired')))
    }
    return api.executionReport(token, shareSessionToken)
  }, [api, shareSessionToken, t, token])
  const runningSteps = useMemo(
    () => steps.filter((step) => (
      stepProgress.some((progress) => (
        progress.step_key === step.key && isStepActiveForStop(progress.status)
      ))
    )),
    [steps, stepProgress],
  )

  const resumableSteps = useMemo(
    () => steps.filter((step) => (
      stepProgress.some((progress) => (
        progress.step_key === step.key
        && isStepResumableWithMessage(progress.status, progress.has_history)
      ))
    )),
    [steps, stepProgress],
  )

  useEffect(() => {
    if (!interactive) return
    setChatTarget((current) => {
      if (runningSteps.some((step) => step.key === current)) return current
      if (resumableSteps.some((step) => step.key === current)) return current
      return runningSteps[0]?.key ?? resumableSteps[0]?.key ?? current
    })
  }, [interactive, runningSteps, resumableSteps])

  const sendStepContent = useCallback(async (content: string): Promise<boolean> => {
    if (!token || phase.kind !== 'ready' || !task) return false
    const selectedTargetReady = chatTarget !== 'coordinator' && (
      runningSteps.some((step) => step.key === chatTarget)
      || resumableSteps.some((step) => step.key === chatTarget)
    )
    const target = selectedTargetReady
      ? chatTarget
      : runningSteps[0]?.key || resumableSteps[0]?.key
    if (!target) {
      setChatError(t('share.noInteractiveStep'))
      return false
    }
    setChatError('')
    try {
      const stepProgressItem = stepProgress.find((item) => item.step_key === target)
      const canResume = stepProgressItem
        && isStepResumableWithMessage(
          stepProgressItem.status,
          stepProgressItem.has_history,
        )
      const accepted = canResume
        ? await api.resumeStep(token, phase.sessionToken, target, content)
        : await api.sendStepMessage(
            token,
            phase.sessionToken,
            task.id,
            target,
            content,
          )
      appendOptimisticMessage(createOptimisticUserMessage(
        accepted.message_id,
        content,
        target,
        accepted.created_at || new Date().toISOString(),
      ))
      await refreshSharedTask()
      return true
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.sendFailed'))
      return false
    }
  }, [
    api,
    token,
    phase,
    task,
    chatTarget,
    stepProgress,
    runningSteps,
    resumableSteps,
    t,
    refreshSharedTask,
    appendOptimisticMessage,
  ])

  const handleSend = useCallback(async () => {
    const content = prompt.trim()
    if (!content) return
    const sent = await sendStepContent(content)
    if (sent) setPrompt('')
  }, [prompt, sendStepContent])

  const handleStopStep = useCallback(async (stepKey: string) => {
    if (!token || phase.kind !== 'ready') return
    if (stoppingStepKeys.includes(stepKey)) return
    setStoppingStepKeys((current) => [...current, stepKey])
    setChatError('')
    try {
      await api.cancelStep(token, phase.sessionToken, stepKey)
      await refreshSharedTask()
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : t('taskDetail.stopFailed'))
    } finally {
      setStoppingStepKeys((current) => current.filter((key) => key !== stepKey))
    }
  }, [
    api,
    token,
    phase,
    stoppingStepKeys,
    t,
    refreshSharedTask,
  ])

  const respondInteraction = useCallback(async (id: string, response: Record<string, unknown>) => {
    if (!token || phase.kind !== 'ready' || !interactive) return
    await api.respondInteraction(token, phase.sessionToken, id, response)
    await refreshSharedTask()
  }, [api, token, phase, interactive, refreshSharedTask])

  const decideReview = useCallback(async (action: ReviewDecisionAction, review?: any, stepKey?: string) => {
    const selected = review || reviews.find(item => item.step_key === currentStep.key && item.status === 'pending')
    if (!token || phase.kind !== 'ready' || !interactive || !selected || reviewBusy.current || action === 'set-complete') return
    reviewBusy.current = true; setReviewPending(true); setChatError('')
    try {
      await api.decideReview(token, phase.sessionToken, stepKey || selected.step_key, selected.id,
        action, reviewComment.trim() || undefined)
      setReviewComment(''); setReviewConfirmation(null)
      await refreshSharedTask()
    } catch (reason) { setChatError(reason instanceof Error ? reason.message : t('taskDetail.reviewActionFailed')) }
    finally { reviewBusy.current = false; setReviewPending(false) }
  }, [api, token, phase, interactive, reviews, currentStep.key, reviewComment, refreshSharedTask, t])

  const findArtifact = (
    name: string,
    preferredStepKey?: string,
    source?: TaskArtifact[],
    round?: number,
    path?: string,
  ) => {
    return findPreferredArtifact(source || artifacts, name, preferredStepKey, round, path)
  }

  const openArtifact = (
    name: string,
    preferredStepKey?: string,
    round?: number,
    path?: string,
  ) => {
    const artifact = findArtifact(name, preferredStepKey, undefined, round, path)
    if (artifact) {
      setPreviewArtifact(artifact)
    } else {
      setArtifactNotice(t('taskDetail.artifactNotFound', { name }))
      window.setTimeout(() => setArtifactNotice(null), 3000)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  if (!token) {
    return (
      <SharePageShell>
        <p className="shared-task-error">{t('share.shareNotFound')}</p>
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
        <div className="shared-task-error-panel">
          {phase.message || t('share.shareNotFound')}
          <Button onClick={retry}>{t('common.retry')}</Button>
        </div>
      </SharePageShell>
    )
  }

  if (phase.kind === 'need-password' || phase.kind === 'unlocking') {
    const unlocking = phase.kind === 'unlocking'
    const m = phase.meta
    return (
      <SharePageShell>
        <div className="shared-task-unlock">
          <div className="shared-task-unlock-title">
            {t('share.enterPassword')}
          </div>
          <div className="shared-task-unlock-subtitle">
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
            className="shared-task-unlock-input"
          />
          {error && (
            <div className="shared-task-unlock-error" role="alert">
              {error}
            </div>
          )}
          <Button
            variant="primary"
            loading={unlocking}
            disabled={!password.trim()}
            onClick={handleUnlock}
            className="shared-task-unlock-button"
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
  const headerActions = (
    <span className="shared-task-connection" data-status={wsStatus}>
      {loadingOlder && <Spinner size={14} />}
      <span className="shared-task-connection-dot" />{wsLabel}
    </span>
  )

  return (
    <SharePageShell>
      <TaskDetailPage
        chatEnabled={interactive}
        gitCapability={{ api: sharedGitApi, projectId: 'shared', shared: true, readOnly: !interactive, workspaceEditable: api.gitWorkspaceEditable, allowedActions: api.gitAllowedActions }}
        task={task}
        steps={steps}
        workflowConnections={task?.workflow?.steps?.connections || []}
        stepProgress={stepProgress}
        selectedStep={selectedStep}
        onStepClick={setSelectedStep}
        historyMessages={messages}
        onLoadOlderHistory={loadOlderHistory}
        readCapabilities={{
          artifactDirectory,
          resolveAssetUrl: markdownUrlResolver,
          filePreview: sharedFilePreview,
          loadMessageEvents,
          openArtifact,
          loadExecutionReport: executionReportLoader,
          browseGitWorkspace,
        } satisfies TaskDetailReadCapabilities}
        liveMessages={{}}
        events={[]}
        content=""
        reviews={reviews}
        reviewCanCompleteStep={false}
        reviewComment={reviewComment}
        onReviewCommentChange={setReviewComment}
        reviewActionPending={reviewPending}
        onReviewAction={interactive ? (action, review, stepKey) => {
          const selected = review || reviews.find(item => item.step_key === currentStep.key && item.status === 'pending')
          if (selected && action !== 'set-complete') setReviewConfirmation({ action, review: selected, stepKey: stepKey || selected.step_key })
        } : undefined}
        onInteractionRespond={interactive ? respondInteraction : undefined}
        chatTarget={chatTarget}
        onChatTargetChange={setChatTarget}
        chatError={chatError || error || ''}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={interactive ? handleSend : undefined}
        chatAttachment={interactive && token ? {
          prefix: task.id.slice(0, 8),
          upload: (file, prefix) => api.uploadAttachment(
            token,
            shareSessionToken,
            file,
            prefix,
          ),
          onError: setChatError,
        } : undefined}
        onStopStep={interactive ? handleStopStep : undefined}
        stoppingStepKeys={stoppingStepKeys}
        artifacts={artifacts}
        headerActions={headerActions}
        locale={locale}
        durationNowMs={durationNowMs}
        currentStep={currentStep}
        activeStep={activeStep}
        currentStepColor={currentStepColor}
        activeStepColor={activeStepColor}
        taskCompleted={taskCompleted}
        runningSteps={runningSteps}
        executionStepModel={executionStepModel}
        sessionIdForStep={() => null}
        onViewingPromptChange={() => {}}
        running={task.status === 'running'}
        previewArtifact={previewArtifact}
        onCloseArtifactPreview={() => setPreviewArtifact(null)}
        artifactNotice={artifactNotice || undefined}
      />
      <ConfirmDialog open={!!reviewConfirmation} title={t('taskDetail.reviewResult')}
        message={reviewConfirmation ? `${task.title} · ${reviewConfirmation.stepKey} · ${reviewActionLabels[reviewConfirmation.action]}` : ''}
        loading={reviewPending} danger={reviewConfirmation?.action === 'terminate' || reviewConfirmation?.action === 'reject'}
        onConfirm={() => { if (reviewConfirmation) void decideReview(reviewConfirmation.action, reviewConfirmation.review, reviewConfirmation.stepKey) }}
        onCancel={() => { if (!reviewBusy.current) setReviewConfirmation(null) }} />
    </SharePageShell>
  )
}

function SharePageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shared-task-page">
      <div className="shared-task-page-content">
        {children}
      </div>
    </div>
  )
}

function LoadingHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="shared-task-loading">
      <Spinner size={14} />
      {children}
    </div>
  )
}
