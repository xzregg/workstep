import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import Button from '../components/Button'
import Input from '../components/Input'
import Spinner from '../components/Spinner'
import TaskDetailPage, { type TaskDetailReadCapabilities } from '../components/TaskDetailPage'
import { createGitApi } from '../api/git'
import { hasActiveTaskExecution } from '../utils/taskDisplayStatus'
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
  isStepActiveForStop,
  isTaskCompleted,
  resolveStepDisplayStatus,
  findActiveStepIndex,
} from './taskDetailChat'
import { findPreferredArtifact } from './taskArtifactRules'
import { sharedTaskArtifactFiles, sharedTaskFilePath } from './sharedTaskFiles'
import { useI18n } from '../i18n'
import type { SharedTaskApi } from '../api/share'
import { useSharedTaskSession } from '../hooks/useSharedTaskSession'
import { MarkdownAssetUrlProvider } from '../contexts/MarkdownAssetUrlContext'
import FilePreviewPage from './FilePreviewPage'
import { gatewayResourceUrl } from '../utils/gatewayWorkspacePath'
import SharedEditableTaskDetail from './SharedEditableTaskDetail'
import TaskWorkflowTools from '../components/TaskWorkflowTools'

export default function SharedTaskView({ api = shareApi }: { api?: SharedTaskApi }) {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const standalonePreview = searchParams.get('preview') === '1'
  const { t, locale } = useI18n()
  const {
    phase, meta, task, messages, artifacts, artifactDirectory, inputSnapshots, reviews, wsStatus, retry, loadOlderHistory, loadingOlder,
    password, setPassword, error, unlock: handleUnlock, loadMessageEvents,
  } = useSharedTaskSession(token, api, { live: !standalonePreview, passwordHint: searchParams.get('_t') || '' })
  const artifactFiles = useMemo(() => sharedTaskArtifactFiles(artifacts), [artifacts])
  const loadWorkflow = useCallback(async () => {
    const configuration = task?.workflow_configuration
    if (configuration) return configuration
    const workflow = task?.workflow?.steps || { nodes: (task?.steps || []).map((step) => ({
      id: step.step_key, type: step.step_key, title: step.step_key,
    })), connections: [] }
    return { workflow, source: workflow,
      revision: '', editable: false, has_overrides: false, conflict: null }
  }, [task])
  const sharedArtifactDirectory = artifactDirectory || (artifacts[0]?.source_path
    ? `.workstep/artifacts/${artifacts[0].source_path.split('/').slice(0, 2).join('/')}` : '')
  const [previewArtifact, setPreviewArtifact] = useState<TaskArtifact | null>(null)
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState(0)
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now())
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
      else if (step?.waiting_reason === 'tool_approval') visualState = 'tool_approval'
      else if (step?.waiting_reason === 'user_input') visualState = 'user_input'
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
  const taskCompleted = isTaskCompleted(stepProgress.map((step) => ({
    status: step.status || 'pending', started_at: step.started_at || null,
  })))
  const interactive = meta?.mode === 'interactive'
  const shareSessionToken = phase.kind === 'ready' ? phase.sessionToken : ''
  const loadSchedules = useCallback(() => api.schedules(token || '', shareSessionToken), [api, token, shareSessionToken])
  const sharedGitApi = useMemo(() => createGitApi(<T,>(path: string, options?: RequestInit) =>
    api.gitRequest<T>(token || '', shareSessionToken, path, options),
  ), [api, token, shareSessionToken])
  const markdownUrlResolver = useCallback(
    (src: string) => token && shareSessionToken
      ? api.resolveAttachmentUrl(token, shareSessionToken, src)
      : src,
    [api, token, shareSessionToken],
  )
  const sharedArtifactsRef = useRef(artifacts)
  sharedArtifactsRef.current = artifacts
  const sharedFilePreview = useMemo(() => ({
    isolatedHtml: true,
    load: (path: string) => token && shareSessionToken
      ? api.previewFile(token, shareSessionToken, sharedTaskFilePath(path, sharedArtifactsRef.current))
      : Promise.reject(new Error(t('share.sessionExpired'))),
    rawUrl: (path: string) => token && shareSessionToken
      ? api.fileUrl(token, shareSessionToken, sharedTaskFilePath(path, sharedArtifactsRef.current))
      : '',
    windowUrl: (path: string, name: string, line?: number) => {
      const params = new URLSearchParams({ preview: '1', path, name })
      if (line !== undefined) params.set('line', String(line))
      return gatewayResourceUrl(`/share/${encodeURIComponent(token || '')}?${params}`)
    },
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

  const findArtifact = (
    name: string,
    preferredStepKey?: string,
    source?: TaskArtifact[],
    round?: number,
    path?: string,
  ) => {
    return findPreferredArtifact(source || artifactFiles, name, preferredStepKey, round, path)
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

  if (phase.kind === 'need-login') {
    const next = window.location.pathname + window.location.search
    return <SharePageShell><div className="shared-task-error-panel">
      <p>{t('share.loginRequired')}</p>
      <a href={`/auth?next=${encodeURIComponent(next)}`}>{t('share.loginAction')}</a>
      <Button onClick={retry}>{t('common.retry')}</Button>
    </div></SharePageShell>
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

  if (standalonePreview && !interactive) return (
    <MarkdownAssetUrlProvider resolver={markdownUrlResolver} filePreview={sharedFilePreview}>
      <FilePreviewPage />
    </MarkdownAssetUrlProvider>
  )

  if (interactive && token) return (
    <SharePageShell>
      <SharedEditableTaskDetail previewOnly={standalonePreview} token={token} session={shareSessionToken} api={api} task={task}
        messages={messages} artifacts={artifactFiles} inputSnapshots={inputSnapshots} reviews={reviews}
        readCapabilities={{ loadSchedules, loadWorkflow, artifactDirectory: sharedArtifactDirectory, resolveAssetUrl: markdownUrlResolver,
          filePreview: sharedFilePreview, loadMessageEvents, openArtifact,
          loadExecutionReport: executionReportLoader, browseGitWorkspace }}
        gitCapability={{ api: sharedGitApi, projectId: 'shared', shared: true, readOnly: false,
          workspaceEditable: api.gitWorkspaceEditable, allowedActions: api.gitAllowedActions }}
        attachment={{ prefix: task.id.slice(0, 8),
          upload: (file, prefix) => api.uploadAttachment(token, shareSessionToken, file, prefix) }}
        loadOlderHistory={loadOlderHistory} />
    </SharePageShell>
  )

  return (
    <SharePageShell>
      <TaskDetailPage
        chatEnabled={false}
        gitCapability={{ api: sharedGitApi, projectId: 'shared', shared: true, readOnly: true, workspaceEditable: api.gitWorkspaceEditable, allowedActions: api.gitAllowedActions }}
        task={task}
        steps={steps}
        workflowConnections={task?.workflow?.steps?.connections || []}
        workflowTools={task?.workflow_configuration && <TaskWorkflowTools taskId={task.id} projectId="shared"
          configuration={task.workflow_configuration} readOnly onChanged={() => undefined} />}
        stepProgress={stepProgress}
        selectedStep={selectedStep}
        onStepClick={setSelectedStep}
        historyMessages={messages}
        onLoadOlderHistory={loadOlderHistory}
        readCapabilities={{
          loadSchedules,
          loadWorkflow,
          artifactDirectory: sharedArtifactDirectory,
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
        reviewComment=""
        chatTarget="coordinator"
        chatError={error || ''}
        prompt=""
        stoppingStepKeys={[]}
        artifacts={artifactFiles}
        artifactInputSnapshots={inputSnapshots}
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
        sessionIdForStep={(key) => stepProgress.find(step => step.step_key === key)?.session_id || null}
        onViewingPromptChange={setViewingPrompt}
        viewingPrompt={viewingPrompt}
        onCloseViewingPrompt={() => setViewingPrompt(null)}
        running={hasActiveTaskExecution(task)}
        previewArtifact={previewArtifact}
        onCloseArtifactPreview={() => setPreviewArtifact(null)}
        artifactNotice={artifactNotice || undefined}
      />
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
