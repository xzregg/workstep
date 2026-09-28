import ProjectGitButton from '../components/git/ProjectGitButton'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AssistantChatPanel from '../components/AssistantChatPanel'
import { ProjectActionMessages } from '../components/ProjectActionMessages'
import { useProjectActions } from '../components/useActionRuns'
import Button from '../components/Button'
import ChatSessionRenameDialog from '../components/ChatSessionRenameDialog'
import EmptyState from '../components/EmptyState'
import Icon from '../components/Icon'
import MobileSheet from '../components/MobileSheet'
import OpenLocationButton from '../components/OpenLocationButton'
import MobileOpenLocationButton from '../components/MobileOpenLocationButton'
import ProjectDirectoryBrowserDialog from '../components/ProjectDirectoryBrowserDialog'
import ProjectSettingsPanel from '../components/ProjectSettingsPanel'
import { ArchivedChatSessionsDialog } from '../components/ArchivedChatSessions'
import {
  assistantApi,
  chatSessionApi,
  providerApi,
  type AssistantConfigInfo,
  type ProviderInfo,
} from '../api/client'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import {
  publishEngineCatalog,
  useCoordinatorEngines,
} from '../stores/engineAvailabilityStore'
import { useProjectStore } from '../stores/projectStore'
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import { useEngineQuota } from '../hooks/useEngineQuota'
import { useChatSessionTransitions } from '../hooks/useChatSessionTransitions'
import { useChatSessionActions } from '../hooks/useChatSessionActions'
import { useChatSessionHistory } from '../hooks/useChatSessionHistory'
import { useChatSessionEngineSelection } from '../hooks/useChatSessionEngineSelection'
import { useThrottledMemo } from '../hooks/useThrottledMemo'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
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

export default function ChatPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectParam = searchParams.get('project')
  const workflowParam = searchParams.get('workflow')
  const sessionParam = searchParams.get('session')

  const {
    projects,
    activeProject,
    loading: projectsLoading,
    fetchProjects,
    setActiveProject,
    setActiveWorkflow,
  } = useProjectStore()

  // 草稿/队列等本地状态必须按 URL 中的项目归属保存；
  // activeProject 可能因点击侧栏其他项目的流程而先行变化。
  const routeProjectId = (
    projectParam
      ? projects.find((item) => item.name === projectParam)?.id
      : activeProject?.id
  ) || ''
  const [sessionId, setSessionId] = useState<string | null>(sessionParam)
  const [sessionTitle, setSessionTitle] = useState('')
  const [input, setInput] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showSettingsPanel, setShowSettingsPanel] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [showMobileDirectoryBrowser, setShowMobileDirectoryBrowser] = useState(false)
  const compact = useCompactLayout()

  // Engine/model picker (session-scoped, mirrors the flow assistant wiring).
  const [assistantConfig, setAssistantConfig] = useState<AssistantConfigInfo | null>(null)
  // 引擎可用性（选项是否禁用）跟随共享状态，设置页改动即时生效。
  const sharedEngines = useCoordinatorEngines()
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const {
    config: engineConfig, setDefaults, restoreSession, applyHandoff,
    chooseEngine, chooseProvider, setModel: setSelectedModel,
    setFastModel: setSelectedFastModel, setVisionModel: setSelectedVisionModel,
    setThinkingEffort: setSelectedThinkingEffort, reset: resetEngineSelection,
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
  const [permissionMode, setPermissionMode] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const [goalMode, setGoalMode] = useState(false)

  const session = useChatSessionStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const messages = session?.messages ?? []
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
  const {
    sendMessageNow, sendPendingContent, stop, sendError, setSendError, stopping,
  } = useChatSessionActions({
    sessionId, projectId: activeProject?.id, running, engineConfig,
    permissionMode, planMode, goalMode, effectiveEngine,
    onSessionIdChange: setSessionId, onTitleChange: setSessionTitle,
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
  const { quota: visibleQuota, refreshing: quotaRefreshing, refresh: refreshQuota } = useEngineQuota(
    activeProject?.id, effectiveEngine, running,
  )
  const {
    openFork, requestEngineHandoff, requestProviderHandoff, dialogs: transitionDialogs,
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
    defaultEngine: assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai',
    engines: sharedEngines,
    providers,
    permissionMode,
    onHandoffApplied: applyHandoff,
    navigate,
  })
  const quickButtons = useChatListStore((s) => s.quickButtons)
  const projectActions = useProjectActions(activeProject?.id, sessionId)
  // AssistantChatPanel 的消息行是 memo 化的：copy/quickPrompts/回调必须引用稳定，
  // 否则流式期间每个 token 都会击穿 memo，历史气泡全量重渲染。
  const panelCopy = useMemo(() => ({
    emptyIntro: t('chatSession.emptyIntro'),
    thinking: t('chatSession.thinking'),
    me: t('chatSession.me'),
    meInitials: t('chatSession.meInitials'),
    agent: t('chatSession.agent'),
    agentInitials: t('chatSession.agentInitials'),
    placeholder: t(compact ? 'chatSession.placeholderCompact' : 'chatSession.placeholder'),
    fullPrompt: t('aiFlow.fullPrompt'),
    closePrompt: t('aiFlow.closePrompt'),
  }), [t, compact])
  const quickPromptItems = useMemo(
    () => quickButtons.map((button) => ({
      id: button.id,
      label: button.label,
      prompt: button.prompt,
      content: button.content,
      kind: button.kind || 'prompt',
      disabled: button.kind === 'action' && projectActions.activeActionIds.includes(button.action_id || button.id),
    })),
    [quickButtons, projectActions.activeActionIds],
  )

  // Resolve project/workflow from the URL (mirrors CanvasEditor's loader).
  useEffect(() => {
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
  }, [projectParam, workflowParam, projects, projectsLoading, fetchProjects, setActiveProject, setActiveWorkflow])

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
        const config = assistants.find((item) => item.name === 'chat_session')
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
  }, [activeProject?.id, t, setDefaults]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let active = true
    if (!activeProject?.id) return
    providerApi.list(activeProject.id)
      .then((result) => {
        if (active) setProviders(result.providers.filter((item) => item.enabled))
      })
      .catch(() => { /* provider list is optional for the engine picker */ })
    return () => { active = false }
  }, [activeProject?.id])

  useEffect(() => {
    if (!activeProject?.id) return
    void useChatListStore.getState().fetchQuickButtons(activeProject.id)
  }, [activeProject?.id])

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

  const { loadMessageEvents } = useChatSessionHistory({
    sessionId: sessionParam,
    messageSessionId: sessionId,
    projectId: activeProject?.id,
    onLoaded: (detail) => {
      setSessionTitle(detail.title || '')
      setPermissionMode(detail.permission_mode || '')
      restoreSession(detail)
    },
    onMissing: () => {
      navigate(`/chat?project=${encodeURIComponent(projectParam || '')}`, { replace: true })
    },
  })

  // Keep the sidebar session list fresh (titles/previews after turns).
  useEffect(() => {
    if (!activeProject?.id) return
    void useChatListStore.getState().fetchSessions(activeProject.id)
  }, [activeProject?.id, running])

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
      await chatSessionApi.updatePermissionMode(sessionId, activeProject.id, mode)
    } catch (reason) {
      setPermissionMode(previousMode)
      setSendError(
        reason instanceof Error
          ? reason.message
          : t('chatSession.permissionUpdateFailed'),
      )
    }
  }, [activeProject?.id, permissionMode, sessionId, t])

  const send = useCallback(async (contentOverride?: string) => {
    const content = (contentOverride ?? input).trim()
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return false
    }
    setInput('')
    clearDraft(sessionId, activeProject?.id ?? '')
    resetEnhance()
    return sendMessageNow(content)
  }, [input, sessionId, activeProject?.id, sendMessageNow, t, resetEnhance])

  const handleInputChange = useCallback((value: string) => {
    enhanceInputChanged(value)
    setInput(value)
    setSendError('')
  }, [enhanceInputChanged])

  const createSession = useCallback(async () => {
    if (!activeProject?.id || creating) return
    setCreating(true)
    setSendError('')
    try {
      const configured = assistantConfig?.configured
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
      setSessionTitle(detail.title || '')
      navigate(`/chat?project=${encodeURIComponent(projectParam || activeProject?.name || '')}&session=${encodeURIComponent(detail.id)}`)
    } catch (reason) {
      setSendError(
        reason instanceof Error && reason.name === 'TimeoutError'
          ? t('chatSession.createTimeout')
          : reason instanceof Error ? reason.message : t('chatSession.createFailed'),
      )
    } finally {
      setCreating(false)
    }
  }, [activeProject, assistantConfig, creating, projectParam, navigate, t])

  const handleMessageEventsLoad = useCallback((messageId: string) => {
    void loadMessageEvents(messageId)
  }, [loadMessageEvents])
  const handleForkMessage = useCallback((messageId: string) => {
    openFork(selectedEngine, messageId)
  }, [openFork, selectedEngine])

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
                <Button variant="primary" loading={creating} onClick={() => void createSession()}>
                  {t('chatSession.createFirst')}
                </Button>
                <Button variant="ghost" onClick={() => setShowArchive(true)}>
                  <Icon name="archive" size={13} />{t('chatSession.viewArchive')}
                </Button>
              </div>
              {sendError && <div className="chat-session-create-error" role="alert">{sendError}</div>}
            </div>}
          />
        </div>
        {showArchive && <ArchivedChatSessionsDialog projectId={activeProject.id} projectName={activeProject.name} onClose={() => setShowArchive(false)} />}
      </>
    )
  }

  return (
    <>
      <AssistantChatPanel
        projectId={activeProject.id}
        sessionId={sessionId}
        title={sessionTitle || t('chatSession.title')}
        messages={messages}
        actionRuns={projectActions.runs}
        onStopAction={(runId) => { void projectActions.stop(runId) }}
        afterMessages={<ProjectActionMessages state={projectActions} />}
        availableCommands={session?.availableCommands}
        running={running}
        stopping={stopping}
        input={input}
        sendError={sendError}
        locale={locale}
        attachmentPrefix="chat-session"
        scrollKey={sessionId}
        onInputChange={handleInputChange}
        onSend={() => void send()}
        onSendContent={sendPendingContent}
        onStop={() => void stop()}
        onAttachmentError={setSendError}
        onLoadMessageEvents={handleMessageEventsLoad}
        onForkMessage={handleForkMessage}
        quickPromptsLabel={t('chatSession.quickPromptsLabel')}
        quickPrompts={quickPromptItems}
        onQuickPromptItemSelect={(item) => {
          const button = quickButtons.find((candidate) => candidate.id === item.id)
          if (!button || button.kind === 'display') return
          if (button.kind === 'action') { void projectActions.run(button); return }
          if (button.immediate_send) { void send(button.prompt); return }
          const next = applyAssistantQuickPrompt(input, button.prompt)
          setInput(next)
          setSendError('')
        }}
        copy={panelCopy}
        headerActions={(
          <>
            <Button
              variant="ghost"
              size="sm"
              loading={creating}
              title={t('chatSession.newSession')}
              onClick={() => void createSession()}
            >
              {t('chatSession.newSession')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRenameOpen(true)}
            >
              {t('common.rename')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title={t('chatSession.viewArchive')}
              onClick={() => setShowArchive(true)}
            >
              <Icon name="archive" size={13} strokeWidth={2} />
              {t('chatSession.viewArchive')}
            </Button>
            <OpenLocationButton activeProject={activeProject} t={t} />
            <ProjectGitButton project={activeProject} />
            <Button
              variant="ghost"
              size="sm"
              title={t('taskList.settingsTitle')}
              onClick={() => setShowSettingsPanel(true)}
            >
              <Icon name="settings" size={13} strokeWidth={2} />
              {t('taskList.settings')}
            </Button>
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
          defaultThinkingEffort: assistantConfig?.configured.thinking_effort
            || assistantConfig?.resolved?.thinking_effort
            || '',
          disabled: !assistantConfig || coordinatorConfigError !== '' || running,
          error: coordinatorConfigError,
          hint: assistantConfig ? t('chatSession.sessionHint') : '',
          engineTitle: t('chatSession.engineTitle'),
          onEngineChange: (engineId) => {
            const defaultEngine = assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai'
            const targetEngine = engineId || defaultEngine
            if (requestEngineHandoff(targetEngine)) return
            chooseEngine(engineId)
          },
          onProviderChange: (providerId) => {
            if (requestProviderHandoff(providerId || '')) return
            chooseProvider(providerId)
          },
          onModelChange: setSelectedModel,
          onFastModelChange: setSelectedFastModel,
          onVisionModelChange: setSelectedVisionModel,
          onThinkingEffortChange: setSelectedThinkingEffort,
          onReset: resetEngineSelection,
        }}
        permission={{
          value: permissionMode,
          onChange: (mode) => void changePermissionMode(mode),
        }}
        plan={{
          active: planMode,
          onChange: (active) => { setPlanMode(active); if (active) setGoalMode(false) },
          disabled: running,
        }}
        goal={effectiveEngine === 'codex_sdk' ? {
          active: goalMode,
          onChange: (active) => { setGoalMode(active); if (active) setPlanMode(false) },
          disabled: running,
        } : undefined}
        enhance={enhance}
        context={context}
        quota={visibleQuota}
        onRefreshQuota={() => { void refreshQuota() }}
        quotaRefreshing={quotaRefreshing}
      />

      {transitionDialogs}

      {renameOpen && <ChatSessionRenameDialog
        projectId={activeProject.id}
        sessionId={sessionId}
        title={sessionTitle}
        onRenamed={(nextTitle) => { setSessionTitle(nextTitle); setRenameOpen(false) }}
        onClose={() => setRenameOpen(false)}
      />}

      <ProjectSettingsPanel
        project={showSettingsPanel ? activeProject : null}
        onClose={() => setShowSettingsPanel(false)}
      />
      {showArchive && <ArchivedChatSessionsDialog projectId={activeProject.id} projectName={activeProject.name} onClose={() => setShowArchive(false)} />}
      {compact && createPortal(
        <button
          className="mobile-session-kebab"
          aria-label={t('chatSession.sessionMenu')}
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen(true)}
        >
          <Icon name="ellipsis" size={20} />
        </button>,
        document.querySelector('.mobile-header-actions') || document.body,
      )}
      <MobileSheet
        open={mobileMenuOpen}
        title={t('chatSession.sessionMenu')}
        onClose={() => setMobileMenuOpen(false)}
      >
        <Button
          variant="ghost"
          loading={creating}
          onClick={() => { setMobileMenuOpen(false); void createSession() }}
          className="chat-session-mobile-action"
        >
          <Icon name="plus" size={16} /> {t('chatSession.newSession')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setRenameOpen(true) }}
          className="chat-session-mobile-action"
        >
          <Icon name="pencil" size={16} /> {t('common.rename')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setShowArchive(true) }}
          className="chat-session-mobile-action"
        >
          <Icon name="archive" size={16} /> {t('chatSession.viewArchive')}
        </Button>
        <MobileOpenLocationButton onClick={() => { setMobileMenuOpen(false); setShowMobileDirectoryBrowser(true) }} />
        <ProjectGitButton project={activeProject} />
        <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setShowSettingsPanel(true) }}
          className="chat-session-mobile-action"
        >
          <Icon name="settings" size={16} /> {t('taskList.settings')}
        </Button>
      </MobileSheet>
      {showMobileDirectoryBrowser && activeProject && (
        <ProjectDirectoryBrowserDialog
          projectId={activeProject.id}
          title={activeProject.name}
          displayPath={t('browser.projectRoot')}
          onClose={() => setShowMobileDirectoryBrowser(false)}
        />
      )}
    </>
  )
}
