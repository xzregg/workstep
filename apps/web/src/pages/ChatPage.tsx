import { useProjectProviders } from '../hooks/useProjectProviders'
import DigitalPersonHome from '../components/digital-person/DigitalPersonHome'
import DigitalPersonWorkbenchActions from '../components/digital-person/DigitalPersonWorkbenchActions'
import { visibleDigitalPersonMessages } from '../components/digital-person/digitalPersonUiReply'
import type { DigitalPersonProfile } from '../api/digitalPerson'
import DigitalPersonCamera, { type PrepareCameraMessage } from '../components/digital-person/DigitalPersonCamera'
import { useDigitalActivity } from '../components/digital-person/useDigitalActivity'
import DigitalPersonFeedback from '../components/digital-person/DigitalPersonFeedback'
import { useDigitalPerson } from '../components/digital-person/useDigitalPerson'
import { useRecentVisitsStore } from '../stores/recentVisitsStore'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useChatSessionRead, type ChatReadTarget } from '../hooks/useChatSessionRead'
import { useChatListTurnRefresh } from '../hooks/useChatListTurnRefresh'
import ProjectGitButton from '../components/git/ProjectGitButton'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import MobileHeaderActions from '../components/MobileHeaderActions'
import { useNavigate, useSearchParams, type NavigateFunction } from 'react-router-dom'
import AssistantChatPanel, { type AssistantChatPanelProps } from '../components/AssistantChatPanel'
import ChatRoleBinding from '../components/role-center/ChatRoleBinding'
import ChannelConversationContext from '../components/ChannelConversationContext'
import ChatSessionGoalBar from '../components/ChatSessionGoalBar'
import { latestGoalFromMessages } from '../utils/goal'
import { ProjectActionMessages } from '../components/ProjectActionMessages'
import { useProjectActions } from '../components/useActionRuns'
import Button from '../components/Button'
import ChatSessionRenameDialog from '../components/ChatSessionRenameDialog'
import ChatSessionLinkButton from '../components/ChatSessionLinkButton'
import EmptyState from '../components/EmptyState'
import Icon from '../components/Icon'
import Spinner from '../components/Spinner'
import MobileSheet from '../components/MobileSheet'
import OpenLocationButton from '../components/OpenLocationButton'
import MobileOpenLocationButton from '../components/MobileOpenLocationButton'
import ProjectDirectoryBrowserDialog from '../components/ProjectDirectoryBrowserDialog'
import ProjectSettingsPanel from '../components/ProjectSettingsPanel'
import { ArchivedChatSessionsDialog } from '../components/ArchivedChatSessions'
import {
  assistantApi,
  chatSessionApi,
  type AssistantConfigInfo,
  type Project,
} from '../api/client'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import type { AssistantChatMessage } from '../stores/assistantStore'
import {
  publishEngineCatalog,
  useCoordinatorEngines,
} from '../stores/engineAvailabilityStore'
import { useProjectStore } from '../stores/projectStore'
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import { useChatSessionTransitions } from '../hooks/useChatSessionTransitions'
import { useChatSessionActions } from '../hooks/useChatSessionActions'
import { useWorkflowDesignSkill } from '../hooks/useWorkflowDesignSkill'
import { useChatSessionHistory, type InitialSessionHistory } from '../hooks/useChatSessionHistory'
import { useChatSessionEngineSelection } from '../hooks/useChatSessionEngineSelection'
import { useThrottledMemo } from '../hooks/useThrottledMemo'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n, localizeErrorDisplay } from '../i18n'
import { clearDraft } from '../utils/chatDraft'
import { applyAssistantQuickPrompt } from '../utils/taskQuickPrompts.js'
import { contextUsageFromMessages } from '../utils/contextUsage.js'

/* ══════════════════════════════════════════
   ChatPage — Codex-style session chat.

   A project holds many independent chat sessions (not tied to a workflow).
   This page composes the shared AssistantChatPanel (messages/input/quick
   buttons) and adds session management: create, rename, delete, and
   per-project quick buttons. All chat UI comes from existing shared components.
   ══════════════════════════════════════════ */

export interface EmbeddedProjectChat {
  project: Project
  sessionId: string | null
  onSessionChange: (id: string | null) => void
  beforeSend?: () => Promise<boolean>
  emptyContent?: (insert: (text: string) => void) => ReactNode
  afterContent?: (insert: (text: string) => void) => ReactNode
  placeholder?: string
  quickButtons?: boolean
  hideHeader?: boolean
  readTarget?: ChatReadTarget
  initialHistory?: InitialSessionHistory
}

const EMPTY_MESSAGES: AssistantChatMessage[] = []

export default function ChatPage({ embedded, pane, companionProfile }: { companionProfile?: DigitalPersonProfile; embedded?: EmbeddedProjectChat; pane?: EmbeddedProjectChat & { active?: boolean; headerDrag?: AssistantChatPanelProps['headerDrag']; headerActions?: (actions: { createSession: (onCreated: (id: string) => void) => Promise<void>; creating: boolean; canCreate: boolean }) => ReactNode; closeAction?: ReactNode } } = {}) {
  const controlled = embedded || pane
  const isControlled = Boolean(controlled)
  const isEmbedded = Boolean(embedded)
  const shortcutsEnabled = !isEmbedded || embedded?.quickButtons === true
  const beforeSend = embedded?.beforeSend
  const { t, locale } = useI18n()
  const routeNavigate = useNavigate()
  const changeEmbeddedSession = controlled?.onSessionChange
  const navigate = useMemo(() => !changeEmbeddedSession ? routeNavigate : ((to: unknown) => {
    if (typeof to === 'string' && to.startsWith('/chat')) {
      changeEmbeddedSession(new URL(to, window.location.origin).searchParams.get('session'))
    }
  }) as NavigateFunction, [routeNavigate, changeEmbeddedSession])
  const [searchParams] = useSearchParams()
  const projectParam = controlled ? controlled.project.name : searchParams.get('project')
  const workflowParam = controlled ? null : searchParams.get('workflow')
  const sessionParam = controlled ? controlled.sessionId : searchParams.get('session')

  const {
    projects,
    activeProject: selectedProject,
    loading: projectsLoading,
    fetchProjects,
    setActiveProject,
    setActiveWorkflow,
  } = useProjectStore()
  const activeProject = controlled?.project || selectedProject

  // 草稿/队列等本地状态必须按 URL 中的项目归属保存；
  // activeProject 可能因点击侧栏其他项目的流程而先行变化。
  const routeProjectId = controlled?.project.id || (
    projectParam
      ? projects.find((item) => item.name === projectParam)?.id
      : activeProject?.id
  ) || ''
  const [sessionId, setSessionId] = useState<string | null>(sessionParam)
  const [sessionTitle, setSessionTitle] = useState('')
  const [input, setInput] = useState('')
  const pendingSendsRef = useRef(new Set<string>())
  const composerOwnerRef = useRef<string | null>(null)
  composerOwnerRef.current = `${routeProjectId}:${sessionParam}`
  useEffect(() => {
    composerOwnerRef.current = `${routeProjectId}:${sessionParam}`
    return () => { composerOwnerRef.current = null }
  }, [routeProjectId, sessionParam])
  const [renameOpen, setRenameOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [showMobileDirectoryBrowser, setShowMobileDirectoryBrowser] = useState(false)
  const compact = useCompactLayout()
  const { can, canOpenSettings, bound: projectScopedAccess } = useGatewayProjectPermissions(activeProject?.id)

  // Engine/model picker (session-scoped, mirrors the flow assistant wiring).
  const isDigitalPersonWorkspace = Boolean(activeProject?.is_default_workspace && activeProject.type !== 'remote' && !projectScopedAccess && !isEmbedded)
  const loadedDigitalPerson = useDigitalPerson(!companionProfile && isDigitalPersonWorkspace)
  const digitalPerson = companionProfile || loadedDigitalPerson
  const digitalActivity = useDigitalActivity(Boolean(digitalPerson))
  const [assistantConfig, setAssistantConfig] = useState<AssistantConfigInfo | null>(null)
  // 引擎可用性（选项是否禁用）跟随共享状态，设置页改动即时生效。
  const sharedEngines = useCoordinatorEngines()
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const providers = useProjectProviders(activeProject?.id || '')
  const {
    config: engineConfig, permissionMode, setPermissionMode, pendingHandoff, loadedEndpoint, saving: engineConfigSaving, error: engineConfigError,
    setDefaults, restoreSession, applyHandoff,
    chooseEngine, chooseProvider, setModel: setSelectedModel,
    setFastModel: setSelectedFastModel, setVisionModel: setSelectedVisionModel,
    setThinkingEffort: setSelectedThinkingEffort, reset: resetEngineSelection,
    setServiceTier,
  } = useChatSessionEngineSelection({
    projectId: routeProjectId || activeProject?.id || '',
    sessionId, savedSessionId: sessionParam, engines: sharedEngines, providers,
  })
  const selectedEngine = engineConfig.engine
  const selectedProvider = engineConfig.providerId
  const selectedModel = engineConfig.model
  const selectedFastModel = engineConfig.fastModel
  const selectedVisionModel = engineConfig.visionModel
  const selectedThinkingEffort = engineConfig.thinkingEffort
  const [planMode, setPlanMode] = useState(false)
  const [goalMode, setGoalMode] = useState(false)
  const [configReopenSignal, setConfigReopenSignal] = useState(0)

  // 输入模式只属于当前会话，切换项目或会话时恢复默认。
  useEffect(() => {
    setPlanMode(false)
    setGoalMode(false)
  }, [routeProjectId, sessionParam])

  const session = useChatSessionStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const messages = session?.messages ?? EMPTY_MESSAGES
  const filterUiReplies = Boolean(companionProfile || activeProject?.is_default_workspace)
  const displayMessages = useMemo(() => filterUiReplies ? visibleDigitalPersonMessages(messages) : messages, [filterUiReplies, messages])
  const actionSourceEnabled = Boolean(companionProfile || isDigitalPersonWorkspace) && !isEmbedded && pane?.active !== false && can('session.read')
  const actionSource = useMemo(() => ({ routeProjectId, sessionParam, actionSourceEnabled }), [routeProjectId, sessionParam, actionSourceEnabled])
  const currentActionSource = useRef(actionSource)
  useLayoutEffect(() => { currentActionSource.current = actionSource }, [actionSource])
  const [acceptedCompanionReply, setAcceptedCompanionReply] = useState<{ source: typeof actionSource; sessionId: string; replyId: string }>()
  const onCompanionReplyAccepted = useCallback((sessionId: string, replyId: string) => {
    if (currentActionSource.current === actionSource) setAcceptedCompanionReply({ source: actionSource, sessionId, replyId })
  }, [actionSource])
  const uiReply = acceptedCompanionReply?.source === actionSource && acceptedCompanionReply.sessionId === sessionId
    ? messages.find(message => message.id === acceptedCompanionReply.replyId) : undefined
  const renderDigitalFeedback = useCallback((messageId: string) => <DigitalPersonFeedback messageId={messageId} initialValue={digitalActivity?.feedback?.[messageId] || 0} />, [digitalActivity?.feedback])
  // A streaming bubble is authoritative too: history hydration or a missed START
  // event must never let an active turn fall through to the normal /chat endpoint.
  const running = Boolean(session?.running || messages.some((message) => (
    message.role === 'assistant' && message.status === 'running'
  )))
  // messages 引用每个 token 都会重建，而 context 占用要扫描全部事件做 token 估算；
  // 每 token 全量计算会占住主线程（侧栏点击排队、页面切换卡顿），节流到 ~2 次/秒。
  const context = useThrottledMemo(
    () => contextUsageFromMessages(messages),
    [messages],
    500,
  )
  const effectiveEngine = selectedEngine
    || assistantConfig?.configured.engine
    || assistantConfig?.resolved?.engine
    || 'pydantic_ai'
  const cameraPrepare = useRef<PrepareCameraMessage | null>(null)
  const setCameraPrepare = useCallback((prepare: PrepareCameraMessage | null) => { cameraPrepare.current = prepare }, [])
  const prepareCameraContent = useCallback<PrepareCameraMessage>((content, onFaces) => cameraPrepare.current?.(content,onFaces) ?? Promise.resolve(content), [])
  const {
    sendMessageNow, sendPendingContent, stop, continueGoal, endGoal, sendError, setSendError, stopping,
  } = useChatSessionActions({
    sessionId, projectId: activeProject?.id, running, engineConfig,
    permissionMode, planMode, goalMode, effectiveEngine,
    onSessionIdChange: setSessionId, onTitleChange: setSessionTitle, prepareContent: prepareCameraContent,
    onReplyAccepted: actionSourceEnabled ? onCompanionReplyAccepted : undefined,
  })
  const workflowSkill = useWorkflowDesignSkill({
    projectId: routeProjectId, engine: effectiveEngine, sessionId, input, onChange: setInput, running,
    onError: setSendError,
    onLoaded: () => { setPlanMode(false); setGoalMode(false) },
  })
  const {
    enhance,
    onInputChange: enhanceInputChanged,
    reset: resetEnhance,
  } = usePromptEnhance({
    projectId: activeProject?.id,
    getDraft: () => input,
    setDraft: setInput,
    onError: setSendError,
    errorMessage: t('chatSession.enhanceFailed'),
  })
  const {
    openFork, requestEngineHandoff, requestProviderHandoff, requestResetHandoff, handingOff, dialogs: transitionDialogs,
  } = useChatSessionTransitions({
    project: activeProject ? {
      id: activeProject.id,
      routeName: projectParam || activeProject.name,
    } : null,
    sessionId,
    sessionTitle,
    messageIds: messages.map((message) => message.id),
    running,
    current: engineConfig,
    pendingHandoff,
    loadedEndpoint,
    defaultEngine: assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai',
    engines: sharedEngines,
    providers,
    permissionMode,
    onHandoffApplied: applyHandoff,
    navigate,
    onHandoffSettled: () => { setConfigReopenSignal((n) => n + 1) },
  })
  const scopedQuickButtons = useChatListStore((s) => s.quickButtonsByProject[routeProjectId])
  const quickButtonsLoading = useChatListStore(s => s.quickButtonsLoadingByProject[routeProjectId])
  const quickButtonsError = useChatListStore(s => s.quickButtonsErrorByProject[routeProjectId])
  const quickButtons = useMemo(() => scopedQuickButtons || [], [scopedQuickButtons])
  const projectActions = useProjectActions(activeProject?.id, sessionId)
  // AssistantChatPanel 的消息行是 memo 化的：copy/quickPrompts/回调必须引用稳定，
  // 否则流式期间每个 token 都会击穿 memo，历史气泡全量重渲染。
  const hasEmbeddedIntro = Boolean(embedded?.emptyContent)
  const panelCopy = useMemo(() => ({
    emptyIntro: hasEmbeddedIntro ? '' : isEmbedded ? t('chatSession.emptyIntro') : digitalPerson ? `${digitalPerson.name}，${digitalPerson.greeting}` : t('chatSession.welcome', { project: activeProject?.name || '' }),
    thinking: t('chatSession.thinking'),
    me: t('chatSession.me'),
    meInitials: t('chatSession.meInitials'),
    agent: digitalPerson?.name || t('chatSession.agent'),
    agentInitials: <Icon name="bot" size={18} />,
    placeholder: embedded?.placeholder || t(compact ? 'chatSession.placeholderCompact' : 'chatSession.placeholder'),
    fullPrompt: t('aiFlow.fullPrompt'),
    closePrompt: t('aiFlow.closePrompt'),
  }), [t, compact, hasEmbeddedIntro, embedded?.placeholder, isEmbedded, activeProject?.name, digitalPerson])

  // Resolve project/workflow from the URL (mirrors CanvasEditor's loader).
  useEffect(() => {
    if (isControlled) return
    if (!projectParam) return
    const match = projects.find((project) => project.name === projectParam)
    if (!match) {
      if (!projectsLoading) void fetchProjects()
      return
    }
    setActiveProject(match)
    // Only pin the workflow when the URL explicitly names one. When there is
    // no workflow param (e.g. clicking a chat session), leave the current
    // selection untouched so the sidebar flow highlight doesn't jump back to
    // the default workflow.
    if (workflowParam) {
      const targetWf = match.workflows?.find((workflow) => workflow.id === workflowParam)
      if (targetWf) setActiveWorkflow(targetWf.id)
    }
  }, [isControlled, projectParam, workflowParam, projects, projectsLoading, fetchProjects, setActiveProject, setActiveWorkflow])

  // Engine defaults + per-project quick buttons.
  // Only re-fetch when the project changes; session switching does not affect config.
  // The engine *availability* list is published to the shared store so the composer's
  // disabled options keep following the settings page instead of freezing on this snapshot.
  useEffect(() => {
    let active = true
    if (!activeProject?.id) return
    assistantApi.list()
      .then(({ assistants }) => {
        if (!active) return
        const config = assistants.find((item) => item.name === (companionProfile ? 'digital_person' : 'chat_session'))
        if (!config) throw new Error(t('chatSession.configLoadFailed'))
        setAssistantConfig(config)
        publishEngineCatalog(config.available_engines)
        if (!sessionParam) {
          setDefaults(config.configured)
        }
        setCoordinatorConfigError('')
      })
      .catch((reason) => {
        if (!active) return
        setCoordinatorConfigError(reason instanceof Error ? reason.message : t('chatSession.configLoadFailed'))
      })
    return () => { active = false }
  }, [activeProject?.id, Boolean(companionProfile), t, setDefaults]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!shortcutsEnabled || !routeProjectId) return
    void useChatListStore.getState().fetchQuickButtons(routeProjectId)
  }, [shortcutsEnabled, routeProjectId])

  // URL selection owns the page state; history loading owns the request and store.
  useEffect(() => {
    setSessionId(sessionParam)
    if (!sessionParam) {
      setSessionTitle('')
      setInput('')
      setSendError('')
      setPermissionMode('')
      resetEnhance()
    } else {
      resetEnhance()
    }
  }, [sessionParam, activeProject?.id, resetEnhance, setSendError])

  const { loadMessageEvents, loadOlderHistory, historyError, historyLoading, historyReady, retryHistory } = useChatSessionHistory({
    sessionId: sessionParam,
    messageSessionId: sessionId,
    projectId: activeProject?.id,
    initialHistory: embedded?.initialHistory,
    onLoaded: (detail) => {
      if (!isEmbedded && routeProjectId) {
        if (detail.archived) useRecentVisitsStore.getState().removeSessions(routeProjectId, [detail.id])
        else useRecentVisitsStore.getState().visit({
          kind: 'session', id: detail.id, projectId: routeProjectId, title: detail.title || '',
        })
      }
      setSessionTitle(detail.title || '')
      restoreSession(detail)
    },
    onMissing: () => {
      navigate(`/chat?project=${encodeURIComponent(projectParam || '')}`, { replace: true })
    },
  })

  useChatSessionRead(routeProjectId, sessionId===sessionParam?sessionId:null, messages, pane?.active!==false, historyReady, controlled?.readTarget)

  // Navigation uses the sidebar cache. Refresh only after a turn finishes.
  useChatListTurnRefresh(activeProject?.id, sessionId, running)

  // The composer owns draft persistence; a new session starts with empty input.
  useEffect(() => {
    if (!sessionId) setInput('')
  }, [sessionId, routeProjectId])

  const changePermissionMode = useCallback(async (mode: string) => {
    const previousMode = permissionMode
    setPermissionMode(mode)
    if (!sessionId || !activeProject?.id) return
    setSendError('')
    try {
      const updated = await chatSessionApi.updatePermissionMode(sessionId, activeProject.id, mode)
      restoreSession(updated)
    } catch (reason) {
      setPermissionMode(previousMode)
      setSendError(
        reason instanceof Error
          ? reason.message
          : t('chatSession.permissionUpdateFailed'),
      )
    }
  }, [activeProject?.id, permissionMode, sessionId, t, restoreSession])

  const send = useCallback(async (contentOverride?: string, prepared = false, facePersonIds?:string[], recentFaces?:boolean) => {
    if (workflowSkill.loading || handingOff || engineConfigSaving || (sessionParam && !historyReady)) return false
    const content = (contentOverride ?? input).trim()
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return false
    }
    const owner = `${routeProjectId}:${sessionParam}`
    if (pendingSendsRef.current.has(owner)) return false
    pendingSendsRef.current.add(owner)
    try {
      if (beforeSend && !await beforeSend()) return false
      if (composerOwnerRef.current !== owner) return false
      // HTTP acknowledgement can arrive after the realtime reply starts.
      // Release the submitted draft now; a late acknowledgement must never
      // clear a newer draft or overwrite another conversation's input.
      const submittedDraft = input
      const consumesDraft = prepared || input.trim() === content
      if (consumesDraft) {
        setInput(current => current === submittedDraft ? '' : current)
        clearDraft(sessionId, activeProject?.id ?? '')
        resetEnhance()
      }
      const sent = await sendMessageNow(content, false, prepared, facePersonIds, recentFaces)
      if (!sent && consumesDraft && composerOwnerRef.current === owner) {
        setInput(current => current === '' ? submittedDraft : current)
      }
      return sent
    } finally {
      pendingSendsRef.current.delete(owner)
    }
  }, [input, sessionId, routeProjectId, activeProject?.id, sendMessageNow, t, resetEnhance, beforeSend, workflowSkill.loading, handingOff, engineConfigSaving, sessionParam, historyReady, setSendError])

  const handleInputChange = useCallback((value: string) => {
    enhanceInputChanged(value)
    setInput(value)
    setSendError('')
  }, [enhanceInputChanged])

  const createSession = useCallback(async (onCreated?: (id: string) => void) => {
    if (!can('session.create')) return
    if (!activeProject?.id || creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setSendError('')
    try {
      const configured = activeProject.is_default_workspace ? undefined : assistantConfig?.configured
      const detail = await chatSessionApi.create({
        project_id: activeProject.id,
        engine: configured?.engine || undefined,
        provider_id: configured?.provider_id || undefined,
        model: configured?.model || undefined,
        fast_model: configured?.fast_model || undefined,
        vision_model: configured?.vision_model || undefined,
      })
      const summary = {
        id: detail.id,
        project_id: detail.project_id,
        workflow_id: detail.workflow_id,
        title: detail.title,
        engine: detail.engine,
        model: detail.model,
        message_count: detail.message_count,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
      }
      useChatListStore.getState().addSession(summary)
      useChatSessionStore.getState().newSession(detail.id)
      if (onCreated) {
        onCreated(detail.id)
        return
      }
      setSessionTitle(detail.title || '')
      navigate(`/chat?project=${encodeURIComponent(projectParam || activeProject?.name || '')}&session=${encodeURIComponent(detail.id)}`)
    } catch (reason) {
      setSendError(
        reason instanceof Error && reason.name === 'TimeoutError'
          ? t('chatSession.createTimeout')
          : reason instanceof Error ? reason.message : t('chatSession.createFailed'),
      )
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [activeProject, assistantConfig, projectParam, navigate, t, can])

  const handleForkMessage = useCallback((messageId: string, preferSmart?: boolean) => {
    openFork(selectedEngine, messageId, preferSmart)
  }, [openFork, selectedEngine])

  const quickPromptItems = useMemo(
    () => quickButtons.filter((button) => shortcutsEnabled && button.enabled !== false && (button.kind === 'display' || can(button.kind === 'action' ? 'action.run' : 'session.chat'))).map((button) => ({
      id: button.id,
      label: button.label,
      prompt: button.prompt,
      content: button.content,
      kind: button.kind || 'prompt',
      disabled: Boolean(quickButtonsLoading || quickButtonsError || !sessionId || sessionId !== sessionParam || !historyReady || handingOff || engineConfigSaving || (button.kind === 'action' ? projectActions.busy || projectActions.activeActionIds.includes(button.action_id || button.id) : running)),
    })),
    [shortcutsEnabled, quickButtons, quickButtonsLoading, quickButtonsError, projectActions.activeActionIds, projectActions.busy, can, sessionId, sessionParam, historyReady, handingOff, engineConfigSaving, running],
  )

  if (!activeProject) {
    return (
      <div className="chat-session-empty">
        <EmptyState
          icon={<Icon name="bot" size={40} strokeWidth={1.5} />}
          title={t('chatSession.title')}
          description={t('chatSession.noSession')}
          action={<Button variant="primary" onClick={() => navigate('/canvas')}>{t('chatSession.backToCanvas')}</Button>}
        />
      </div>
    )
  }

  if (historyLoading && !historyReady && sessionId && !messages.length) {
    return <div className="chat-session-empty" role="status"><Spinner size={16} />{t('common.loading')}{!compact && pane?.closeAction}</div>
  }

  if (historyError && sessionId) {
    return <div className="chat-session-empty" role="alert">
      <EmptyState icon={<Icon name="bot" size={40} strokeWidth={1.5} />}
        title={t('chatSession.title')} description={historyError}
        action={<div className="chat-session-empty-actions"><Button variant="primary" onClick={retryHistory}>{t('common.retry')}</Button>{!compact && pane?.closeAction}</div>} />
    </div>
  }

  if (!sessionId) {
    return (
      <>
        <div className="chat-session-empty">
          <EmptyState
            icon={<Icon name="bot" size={40} strokeWidth={1.5} />}
            title={t('chatSession.title')}
            description={t('chatSession.noSession')}
            action={<div className="chat-session-empty-action-group">
              <div className="chat-session-empty-actions">
                {can('session.create') && <Button variant="primary" loading={creating} onClick={() => void createSession()}>
                  {t('chatSession.createFirst')}
                </Button>}
                {!compact && pane?.headerActions?.({ createSession, creating, canCreate: can('session.create') })}
                {can('session.manage') && <Button variant="ghost" onClick={() => setShowArchive(true)}>
                  <Icon name="archive" size={13} />{t('chatSession.viewArchive')}
                </Button>}
                {!compact && pane?.closeAction}
              </div>
              {sendError && <div className="chat-session-create-error" role="alert">{localizeErrorDisplay(sendError)}</div>}
            </div>}
          />
        </div>
        {can('session.manage') && showArchive && <ArchivedChatSessionsDialog projectId={activeProject.id} projectName={activeProject.name} onClose={() => setShowArchive(false)} />}
      </>
    )
  }

  const composerDisabled = handingOff || engineConfigSaving || Boolean(sessionParam && !historyReady)
  const sendPending = (content: string, ids: string[]) => composerDisabled ? Promise.resolve(false) : sendPendingContent(content, ids)
  const conversation = (
    <>
      <DigitalPersonCamera floating key={`${routeProjectId}/${sessionId}`} projectId={routeProjectId} active={pane?.active !== false}>
      <ChatRoleBinding key={`${activeProject.id}/${sessionId}`} projectId={activeProject.id} sessionId={sessionId} running={running}
        enabled={(!sessionParam || historyReady) && !isEmbedded && activeProject.type !== 'remote' && !projectScopedAccess && can('session.config')}>
      {roleBinding => <AssistantChatPanel
        renderMessageActions={digitalPerson ? renderDigitalFeedback : undefined}
        connectorsEnabled={activeProject.type !== 'remote'}
        roleBinding={roleBinding}
        workflowSkill={!isEmbedded && activeProject.type !== 'remote' && !projectScopedAccess && can('workflow.create') && can('task.create') ? workflowSkill : undefined}
        projectId={activeProject.id}
        sessionId={sessionId}
        quotaActive={pane?.active !== false}
        headerContext={<ChannelConversationContext projectId={activeProject.id} sessionId={sessionId} />}
        title={sessionTitle || t('chatSession.title')}
        headerDrag={pane?.headerDrag}
        onTitleDoubleClick={!compact && !isEmbedded && can('session.manage') ? () => setRenameOpen(true) : undefined}
        hideHeader={embedded?.hideHeader}
        hideHeaderStatus={!isEmbedded}
        welcome={!isEmbedded}
        messages={displayMessages}
        actionRuns={projectActions.runs}
        onStopAction={(runId) => { void projectActions.stop(runId) }}
        afterMessages={<>
          {messages.length === 0 && embedded?.emptyContent?.(text => { setInput(applyAssistantQuickPrompt(input, text)); setSendError('') })}
          {embedded?.afterContent?.(text => { setInput(applyAssistantQuickPrompt(input, text)); setSendError('') })}
          {can('action.run') && <ProjectActionMessages state={projectActions} />}
          {actionSourceEnabled && loadedDigitalPerson &&
            <DigitalPersonWorkbenchActions mainSessionId={digitalActivity?.main_session_id} sessionId={sessionId} reply={uiReply} />}
        </>}
        availableCommands={session?.availableCommands}
        composerStatus={<>
          {shortcutsEnabled && quickButtonsLoading && <div className="chat-shortcuts-status" role="status"><Spinner size={14}/>{t('common.loading')}</div>}
          {shortcutsEnabled && quickButtonsError && <div className="chat-shortcuts-status chat-shortcuts-error" role="alert">{localizeErrorDisplay(quickButtonsError)}<Button size="sm" onClick={() => void useChatListStore.getState().fetchQuickButtons(routeProjectId)}>{t('common.retry')}</Button></div>}
          {effectiveEngine === 'codex_sdk' ? <ChatSessionGoalBar
          key={sessionId} projectId={routeProjectId} goal={latestGoalFromMessages(messages)} running={running} stopping={stopping}
          onResume={continueGoal} onEnd={endGoal}
        /> : null}</>}
        running={running}
        stopping={stopping}
        input={input}
        sendError={sendError}
        locale={locale}
        attachmentPrefix="chat-session"
        scrollKey={sessionId}
        onInputChange={handleInputChange}
        onSend={(content,ids,recent) => void send(content, content !== undefined,ids,recent)}
        onSendContent={sendPending}
        composerDisabled={composerDisabled}
        onStop={() => void stop()}
        onAttachmentError={setSendError}
        onLoadMessageEvents={loadMessageEvents}
        onLoadOlderHistory={loadOlderHistory}
        onForkMessage={embedded ? undefined : handleForkMessage}
        quickPromptsLabel={t('chatSession.quickPromptsLabel')}
        quickPrompts={quickPromptItems}
        onQuickPromptItemSelect={(item) => {
          const button = quickButtons.find((candidate) => candidate.id === item.id)
          if (!button || button.kind === 'display' || !quickPromptItems.some(candidate => candidate.id === item.id && !candidate.disabled)) return
          if (button.kind === 'action') { if (can('action.run')) void projectActions.run(button); return }
          if (button.immediate_send) { void send(button.prompt); return }
          const next = applyAssistantQuickPrompt(input, button.prompt)
          setInput(next)
          setSendError('')
        }}
        copy={panelCopy}
        headerActions={!embedded && (
          <>
            <div className="chat-header-hover-actions">
            {!compact && <ChatSessionLinkButton projectName={activeProject.name} sessionId={sessionId} />}
            {can('session.create') && <Button
              variant="ghost"
              size="sm"
              loading={creating}
              title={t('chatSession.newSession')}
              onClick={() => void createSession()}
            >
              {t('chatSession.newSession')}
            </Button>}
            {!compact && pane?.headerActions?.({ createSession, creating, canCreate: can('session.create') })}
            {can('session.manage') && <Button
              variant="ghost"
              size="sm"
              title={t('chatSession.viewArchive')}
              onClick={() => setShowArchive(true)}
            >
              <Icon name="archive" size={13} strokeWidth={2} />
              {t('chatSession.viewArchive')}
            </Button>}
            {can('file.read') && <OpenLocationButton activeProject={activeProject} t={t} />}
            </div>
            <div className="chat-header-persistent-actions">
            <ProjectGitButton project={activeProject} />
            {canOpenSettings && <Button
              variant="ghost"
              size="sm"
              title={t('taskList.settingsTitle')}
              onClick={() => setShowSettingsPanel(true)}
            >
              <Icon name="settings" size={13} strokeWidth={2} />
              {t('taskList.settings')}
            </Button>}
            {!compact && pane?.closeAction}
            </div>
          </>
        )}
        config={{
          projectId: activeProject.id,
          engines: sharedEngines,
          engine: selectedEngine,
          providers,
          providerId: selectedProvider,
          defaultEngine: assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai',
          model: selectedModel,
          fastModel: selectedFastModel,
          visionModel: selectedVisionModel,
          showVision: true,
          thinkingEffort: selectedThinkingEffort,
          serviceTier: engineConfig.serviceTier || '',
          onServiceTierChange: setServiceTier,
          defaultThinkingEffort: assistantConfig?.configured.thinking_effort
            || assistantConfig?.resolved?.thinking_effort
            || '',
          disabled: !assistantConfig || coordinatorConfigError !== '' || running || handingOff || engineConfigSaving || Boolean(sessionParam && !historyReady),
          saving: engineConfigSaving,
          error: coordinatorConfigError || engineConfigError,
          hint: assistantConfig ? t('chatSession.sessionHint') : '',
          engineTitle: t('chatSession.engineTitle'),
          onEngineChange: (engineId) => {
            const defaultEngine = assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai'
            const targetEngine = engineId || defaultEngine
            if (targetEngine === effectiveEngine) return
            if (requestEngineHandoff(targetEngine)) {
              // The transition response owns engine and permission together; opening a dialog must not reset either.
              return false
            }
            chooseEngine(engineId)
          },
          onProviderChange: (providerId) => {
            if ((providerId || '') === selectedProvider) return
            if (requestProviderHandoff(providerId || '')) {
              if (compact) return false
              return
            }
            chooseProvider(providerId)
          },
          onModelChange: setSelectedModel,
          onFastModelChange: setSelectedFastModel,
          onVisionModelChange: setSelectedVisionModel,
          onThinkingEffortChange: setSelectedThinkingEffort,
          onReset: () => { if (!requestResetHandoff()) resetEngineSelection() },
          reopenSignal: configReopenSignal,
        }}
        permission={{
          value: permissionMode,
          onChange: (mode) => void changePermissionMode(mode),
        }}
        plan={{
          active: planMode,
          onChange: (active) => { setPlanMode(active); if (active) { setGoalMode(false); workflowSkill.onRemove() } },
          disabled: running || workflowSkill.loading,
        }}
        goal={effectiveEngine === 'codex_sdk' ? {
          active: goalMode,
          onChange: (active) => { setGoalMode(active); if (active) { setPlanMode(false); workflowSkill.onRemove() } },
          disabled: running || workflowSkill.loading,
        } : undefined}
        enhance={enhance}
        context={context}
      />}
      </ChatRoleBinding>
      </DigitalPersonCamera>

      {transitionDialogs}

      {can('session.manage') && renameOpen && <ChatSessionRenameDialog
        projectId={activeProject.id}
        sessionId={sessionId}
        title={sessionTitle}
        onRenamed={(nextTitle) => { setSessionTitle(nextTitle); setRenameOpen(false) }}
        onClose={() => setRenameOpen(false)}
      />}

      <ProjectSettingsPanel
        project={canOpenSettings && showSettingsPanel ? activeProject : null}
        onClose={() => setShowSettingsPanel(false)}
      />
      {can('session.manage') && showArchive && <ArchivedChatSessionsDialog projectId={activeProject.id} projectName={activeProject.name} onClose={() => setShowArchive(false)} />}
      {!embedded && pane?.active !== false && compact && <MobileHeaderActions beforeNew={<ChatSessionLinkButton projectName={activeProject.name} sessionId={sessionId} mobile />}>
        <button
          className="mobile-session-kebab"
          aria-label={t('chatSession.sessionMenu')}
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen(true)}
        >
          <Icon name="ellipsis" size={20} />
        </button>
      </MobileHeaderActions>}
      <MobileSheet
        open={mobileMenuOpen}
        title={t('chatSession.sessionMenu')}
        onClose={() => setMobileMenuOpen(false)}
      >
        {can('session.create') && <Button
          variant="ghost"
          loading={creating}
          onClick={() => { setMobileMenuOpen(false); void createSession() }}
          className="chat-session-mobile-action"
        >
          <Icon name="plus" size={16} /> {t('chatSession.newSession')}
        </Button>}
        {can('session.manage') && <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setRenameOpen(true) }}
          className="chat-session-mobile-action"
        >
          <Icon name="pencil" size={16} /> {t('common.rename')}
        </Button>}
        {can('session.manage') && <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setShowArchive(true) }}
          className="chat-session-mobile-action"
        >
          <Icon name="archive" size={16} /> {t('chatSession.viewArchive')}
        </Button>}
        {can('file.read') && <MobileOpenLocationButton onClick={() => { setMobileMenuOpen(false); setShowMobileDirectoryBrowser(true) }} />}
        <ProjectGitButton project={activeProject} />
        {canOpenSettings && <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setShowSettingsPanel(true) }}
          className="chat-session-mobile-action"
        >
          <Icon name="settings" size={16} /> {t('taskList.settings')}
        </Button>}
      </MobileSheet>
      {can('file.read') && showMobileDirectoryBrowser && activeProject && (
        <ProjectDirectoryBrowserDialog
          projectId={activeProject.id}
          title={activeProject.name}
          displayPath={t('browser.projectRoot')}
          onClose={() => setShowMobileDirectoryBrowser(false)}
        />
      )}
    </>
  )
  return companionProfile ? <DigitalPersonHome profile={companionProfile} activity={digitalActivity}
    projectId={activeProject.id} projectName={activeProject.name} sessionId={sessionId}
    messages={displayMessages} uiReply={uiReply}
    running={running} stopping={stopping} active={pane?.active !== false && Boolean(assistantConfig) && !coordinatorConfigError && !handingOff && !engineConfigSaving} composerDisabled={composerDisabled} onSend={send} onSendPending={sendPending} onStop={stop} inputValue={input} onDraft={handleInputChange} onPrepareCamera={setCameraPrepare} error={sendError || coordinatorConfigError}>{conversation}</DigitalPersonHome> : conversation
}
