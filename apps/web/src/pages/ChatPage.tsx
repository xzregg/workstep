import ProjectGitButton from '../components/git/ProjectGitButton'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { randomUuid } from '../utils/uuid'
import AssistantChatPanel from '../components/AssistantChatPanel'
import { ProjectActionMessages, useProjectActions } from '../components/ProjectActionMessages'
import Button from '../components/Button'
import ChatEngineHandoffDialog, { type HandoffEndpoint } from '../components/ChatEngineHandoffDialog'
import ChatSessionForkDialog from '../components/ChatSessionForkDialog'
import ConfirmDialog from '../components/ConfirmDialog'
import EmptyState from '../components/EmptyState'
import Icon from '../components/Icon'
import Input from '../components/Input'
import MobileSheet from '../components/MobileSheet'
import OpenLocationButton from '../components/OpenLocationButton'
import MobileOpenLocationButton from '../components/MobileOpenLocationButton'
import ProjectDirectoryBrowserDialog from '../components/ProjectDirectoryBrowserDialog'
import ProjectSettingsPanel from '../components/ProjectSettingsPanel'
import { ArchivedChatSessionsDialog } from '../components/ArchivedChatSessions'
import {
  assistantApi,
  chatSessionApi,
  engineApi,
  providerApi,
  type AssistantConfigInfo,
  type EngineQuota,
  type ChatSessionHandoffInput,
  type ProviderInfo,
  type ChatSessionForkInput,
} from '../api/client'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import {
  publishEngineCatalog,
  useCoordinatorEngines,
} from '../stores/engineAvailabilityStore'
import { useProjectStore } from '../stores/projectStore'
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import { useThrottledMemo } from '../hooks/useThrottledMemo'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'
import { clearDraft } from '../utils/chatDraft'
import {
  clearIncompatibleProvider,
  EMPTY_ENGINE_CONFIG,
  hasChatEngineConfig,
  loadChatEngineConfig,
  saveChatEngineConfig,
  type ChatEngineConfigState,
} from '../utils/chatEngineConfig'
import { applyAssistantQuickPrompt } from '../utils/taskQuickPrompts.js'
import { contextUsageFromMessages } from '../utils/contextUsage.js'
import { requiresEngineHandoff } from '../utils/chatSessionFork'

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
  const [sendError, setSendError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const [creating, setCreating] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState('')
  const [forkTargetEngine, setForkTargetEngine] = useState('')
  const [forkMessageId, setForkMessageId] = useState<string | null>(null)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handingOff, setHandingOff] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [handoffTarget, setHandoffTarget] = useState<HandoffEndpoint | null>(null)
  const [confirmedHandoffMessageCount, setConfirmedHandoffMessageCount] = useState<number | null>(null)
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
  const [selectedEngine, setSelectedEngine] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedFastModel, setSelectedFastModel] = useState('')
  const [selectedVisionModel, setSelectedVisionModel] = useState('')
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState('')
  // 镜像最新的引擎配置选择，供切换会话 / 路由卸载时懒保存到 localStorage。
  const engineConfigRef = useRef<ChatEngineConfigState>({ ...EMPTY_ENGINE_CONFIG })
  engineConfigRef.current = {
    engine: selectedEngine,
    providerId: selectedProvider,
    model: selectedModel,
    fastModel: selectedFastModel,
    visionModel: selectedVisionModel,
    thinkingEffort: selectedThinkingEffort,
  }
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [permissionMode, setPermissionMode] = useState('')
  const [planMode, setPlanMode] = useState(false)

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
  const [quota, setQuota] = useState<EngineQuota | null>(null)
  const [quotaRefreshing, setQuotaRefreshing] = useState(false)
  const quotaRequestRef = useRef(0)
  const refreshQuota = useCallback(async () => {
    if (!activeProject?.id) return
    const requestId = ++quotaRequestRef.current
    setQuotaRefreshing(true)
    try {
      const result = await engineApi.quota(effectiveEngine, activeProject.id)
      if (quotaRequestRef.current === requestId) setQuota(result.quota)
    } catch {
      if (quotaRequestRef.current === requestId) setQuota(null)
    } finally {
      if (quotaRequestRef.current === requestId) setQuotaRefreshing(false)
    }
  }, [effectiveEngine, activeProject?.id])
  useEffect(() => {
    if (running || !activeProject?.id) {
      quotaRequestRef.current += 1
      setQuotaRefreshing(false)
      return
    }
    void refreshQuota()
    return () => { quotaRequestRef.current += 1 }
  }, [running, activeProject?.id, refreshQuota])
  const visibleQuota = quota?.engine_id === effectiveEngine ? quota : null
  const providerLabel = useCallback((providerId: string) => (
    providerId
      ? providers.find((item) => item.id === providerId)?.name || providerId
      : t('chatSession.providerDefaultLabel')
  ), [providers, t])
  const handoffSource: HandoffEndpoint = {
    engine: selectedEngine || assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai',
    providerId: selectedProvider,
  }
  const forkMessageIndex = forkMessageId
    ? messages.findIndex((message) => message.id === forkMessageId)
    : -1
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
          const configured = config.configured
          setSelectedEngine(configured.engine || '')
          setSelectedProvider(configured.provider_id || '')
          setSelectedModel(configured.model || '')
          setSelectedFastModel(configured.fast_model || '')
          setSelectedVisionModel(configured.vision_model || '')
          setSelectedThinkingEffort(configured.thinking_effort || '')
        }
        setCoordinatorConfigError('')
      })
      .catch((reason) => {
        if (!active) return
        setCoordinatorConfigError(reason instanceof Error ? reason.message : t('chatSession.configLoadFailed'))
      })
    return () => { active = false }
  }, [activeProject?.id, t]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Load one session's history when the URL session id changes.
  useEffect(() => {
    setSessionId(sessionParam)
    if (!sessionParam) {
      setSessionTitle('')
      setInput('')
      setSendError('')
      setStopping(false)
      setPermissionMode('')
      resetEnhance()
      return
    }
    if (!activeProject?.id) return
    resetEnhance()
    let active = true
    const store = useChatSessionStore.getState()
    store.newSession(sessionParam)
    chatSessionApi.get(sessionParam, activeProject.id)
      .then((detail) => {
        if (!active) return
        setSessionTitle(detail.title || '')
        setPermissionMode(detail.permission_mode || '')
        setSelectedEngine(detail.engine || '')
        setSelectedProvider(detail.provider_id || '')
        setSelectedModel(detail.model || '')
        setSelectedFastModel(detail.fast_model || '')
        setSelectedVisionModel(detail.vision_model || '')
        // 优先恢复本地记录的用户选择（后端会话详情不含 thinking_effort，
        // 且用户可能改过配置但尚未发消息）。无记录时思考强度归默认。
        const saved = loadChatEngineConfig(routeProjectId || activeProject.id, sessionParam)
        if (hasChatEngineConfig(saved)) {
          const restored = clearIncompatibleProvider(
            saved,
            sharedEngines,
            providers,
          )
          if (restored.providerId !== saved.providerId) {
            saveChatEngineConfig(routeProjectId || activeProject.id, sessionParam, restored)
          }
          setSelectedEngine(restored.engine)
          setSelectedProvider(restored.providerId)
          setSelectedModel(restored.model)
          setSelectedFastModel(restored.fastModel)
          setSelectedVisionModel(restored.visionModel)
          setSelectedThinkingEffort(restored.thinkingEffort)
        } else {
          setSelectedThinkingEffort('')
        }
        store.newSession(detail.id)
        store.hydrateSession(
          detail.id,
          (detail.messages || []).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            status: m.status,
            engine: m.engine,
            model: m.model,
            created_at: m.created_at,
            ended_at: m.ended_at,
            prompt: m.prompt,
            author_id: m.author_id,
            author_name: m.author_name,
            author_device_id: m.author_device_id,
            author_device_name: m.author_device_name,
            event_summary: m.event_summary,
            event_detail: m.event_detail,
            events: (m.events || []).map((e) => ({
              ...e,
              type: e.type || '',
              data: e.data || {},
            })),
          })),
          detail.running,
        )
      })
      .catch(() => {
        if (!active) return
        // Session was deleted elsewhere — drop the invalid id from the URL.
        navigate(`/chat?project=${encodeURIComponent(projectParam || '')}`, { replace: true })
      })
    return () => { active = false }
  }, [sessionParam, activeProject?.id, projectParam, workflowParam, routeProjectId, navigate, resetEnhance, sharedEngines, providers])

  // Keep the sidebar session list fresh (titles/previews after turns).
  useEffect(() => {
    if (!activeProject?.id) return
    void useChatListStore.getState().fetchSessions(activeProject.id)
  }, [activeProject?.id, running])

  // Reset transient state when switching sessions. The composer owns draft
  // persistence; this effect only clears page-local UI state.
  useEffect(() => {
    if (!sessionId) setInput('')
    setSendError('')
    setStopping(false)
    setConfirmedHandoffMessageCount(null)
  }, [sessionId, routeProjectId])

  // 引擎配置同样懒保存：切换会话 / 路由卸载时把当前会话的选择落盘。
  useEffect(() => {
    if (!sessionId || !routeProjectId) return
    return () => {
      saveChatEngineConfig(routeProjectId, sessionId, engineConfigRef.current)
    }
  }, [sessionId, routeProjectId])

  const sendMessageNow = useCallback(async (
    content: string,
  ): Promise<boolean> => {
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return false
    }
    if (!activeProject?.id) return false
    setSendError('')
    try {
      useChatSessionStore.getState().addUserMessage(sessionId, content)
      const accepted = await chatSessionApi.chat(sessionId, activeProject.id, content, randomUuid(), {
        engine: selectedEngine || undefined,
        provider_id: selectedProvider || undefined,
        model: selectedModel || undefined,
        fast_model: selectedFastModel || undefined,
        vision_model: selectedVisionModel || undefined,
        thinking_effort: selectedThinkingEffort || undefined,
        permission_mode: permissionMode || undefined,
        plan_mode: planMode || undefined,
      })
      if (accepted.session_id && accepted.session_id !== sessionId) {
        const store = useChatSessionStore.getState()
        const oldSession = store.sessions[sessionId]
        store.newSession(accepted.session_id)
        if (oldSession) {
          useChatSessionStore.setState((s) => ({
            sessions: { ...s.sessions, [accepted.session_id]: oldSession },
          }))
          store.resetSession(sessionId)
        }
        setSessionId(accepted.session_id)
      }
      // Auto-title from the first user message: refresh the header + sidebar.
      const finalSessionId = accepted.session_id || sessionId
      if (activeProject?.id) {
        const { sessions } = await chatSessionApi.list(activeProject.id)
        const summary = sessions.find((s) => s.id === finalSessionId)
        if (summary?.title) {
          setSessionTitle(summary.title)
          useChatListStore.getState().renameSession(finalSessionId, summary.title)
        }
      }
      return true
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
      return false
    }
  }, [sessionId, activeProject?.id, selectedEngine, selectedProvider, selectedModel, selectedFastModel, selectedVisionModel, selectedThinkingEffort, permissionMode, planMode, t])

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

  const sendPendingContent = useCallback(async (
    content: string,
    pendingInsertIds: string[],
  ): Promise<boolean> => {
    if (!sessionId || !activeProject?.id) return false
    if (!running) return sendMessageNow(content)
    setSendError('')
    try {
      await chatSessionApi.sendLiveMessage(
        sessionId,
        activeProject.id,
        content,
        pendingInsertIds,
      )
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : ''
      if (message.includes('待插入消息已被处理')) return true
      if (message.includes('not running') || message.includes('未在运行')) {
        return sendMessageNow(content)
      }
      setSendError(message || t('chatSession.sendFailed'))
      return false
    }
  }, [activeProject?.id, running, sendMessageNow, sessionId, t])

  const handleInputChange = useCallback((value: string) => {
    enhanceInputChanged(value)
    setInput(value)
    setSendError('')
  }, [enhanceInputChanged])

  const stop = useCallback(async () => {
    if (!sessionId || !activeProject?.id || stopping) return
    setStopping(true)
    setSendError('')
    try {
      const result = await chatSessionApi.stop(sessionId, activeProject.id)
      if (result.stopped) {
        useChatSessionStore.getState().markStopped(sessionId)
      } else {
        setSendError(t('chatSession.stopFailed'))
      }
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('chatSession.stopFailed'))
    } finally {
      setStopping(false)
    }
  }, [sessionId, activeProject?.id, stopping, t])

  const loadMessageEvents = useCallback(async (messageId: string) => {
    if (!sessionId || !activeProject?.id) return
    const store = useChatSessionStore.getState()
    const message = store.sessions[sessionId]?.messages.find((item) => item.id === messageId)
    if (!message?.event_detail?.available || message.event_detail.loaded || message.event_detail.loading) return
    store.setMessageEventLoading(sessionId, messageId, true)
    try {
      let cursor = 0
      let complete = false
      const events = [] as NonNullable<typeof message.events>
      while (!complete) {
        const page = await chatSessionApi.messageEvents(
          sessionId,
          messageId,
          activeProject.id,
          cursor,
        )
        events.push(...page.events.map((event) => ({
          ...event,
          type: event.type || '',
          data: event.data || {},
        })))
        complete = page.complete || page.next_cursor === null
        if (!complete) {
          const nextCursor = page.next_cursor
          if (nextCursor === null || nextCursor === cursor) {
            throw new Error('Event detail cursor did not advance')
          }
          cursor = nextCursor
        }
      }
      store.setMessageEventDetails(sessionId, messageId, events, {
        complete: true,
        next_cursor: null,
      })
    } catch (reason) {
      store.setMessageEventLoading(
        sessionId,
        messageId,
        false,
        reason instanceof Error ? reason.message : t('chatSession.loadFailed'),
      )
    }
  }, [sessionId, activeProject?.id, t])

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
      setSendError(reason instanceof Error ? reason.message : t('chatSession.createFailed'))
    } finally {
      setCreating(false)
    }
  }, [activeProject, assistantConfig, creating, projectParam, navigate, t])

  const openFork = useCallback((targetEngine = selectedEngine, messageId: string | null = null) => {
    if (!sessionId || running) return
    setForkTargetEngine(targetEngine || selectedEngine)
    setForkMessageId(messageId)
    setForkError('')
    setForkOpen(true)
  }, [sessionId, running, selectedEngine])

  const handleMessageEventsLoad = useCallback((messageId: string) => {
    void loadMessageEvents(messageId)
  }, [loadMessageEvents])
  const handleForkMessage = useCallback((messageId: string) => {
    openFork(selectedEngine, messageId)
  }, [openFork, selectedEngine])

  const forkSession = useCallback(async (input: ChatSessionForkInput) => {
    if (!sessionId || !activeProject?.id || forking) return
    setForking(true)
    setForkError('')
    try {
      const detail = await chatSessionApi.fork(sessionId, input)
      useChatListStore.getState().addSession(detail)
      useChatSessionStore.getState().newSession(detail.id)
      setForkOpen(false)
      navigate(`/chat?project=${encodeURIComponent(projectParam || activeProject.name || '')}&session=${encodeURIComponent(detail.id)}`)
    } catch (reason) {
      setForkError(reason instanceof Error ? reason.message : t('chatSession.forkFailed'))
    } finally {
      setForking(false)
    }
  }, [sessionId, activeProject, forking, navigate, projectParam, t])

  const handoffSession = useCallback(async (input: ChatSessionHandoffInput) => {
    if (!sessionId || !activeProject?.id || handingOff) return
    setHandingOff(true)
    setHandoffError('')
    try {
      const detail = await chatSessionApi.handoff(sessionId, input)
      setSelectedEngine(detail.engine || '')
      setSelectedProvider(detail.provider_id || '')
      setSelectedModel(detail.model || '')
      setSelectedFastModel(detail.fast_model || '')
      setSelectedVisionModel(detail.vision_model || '')
      setSelectedThinkingEffort('')
      setConfirmedHandoffMessageCount(messages.length)
      setHandoffOpen(false)
      await useChatListStore.getState().fetchSessions(activeProject.id)
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : t('chatSession.handoffFailed'))
    } finally {
      setHandingOff(false)
    }
  }, [sessionId, activeProject?.id, handingOff, messages.length, t])

  const renameSession = useCallback(async () => {
    const title = renameValue.trim()
    if (!title) {
      setRenameError(t('chatSession.renameEmptyHint'))
      return
    }
    if (!activeProject?.id || !sessionId || renaming) return
    setRenaming(true)
    setRenameError('')
    try {
      const updated = await chatSessionApi.rename(sessionId, activeProject.id, title)
      setSessionTitle(updated.title)
      useChatListStore.getState().renameSession(sessionId, updated.title)
      setRenameOpen(false)
    } catch (reason) {
      setRenameError(reason instanceof Error ? reason.message : t('chatSession.renameFailed'))
    } finally {
      setRenaming(false)
    }
  }, [renameValue, activeProject?.id, sessionId, renaming, t])

  if (!activeProject) {
    return (
      <div style={{ flex: 1, display: 'flex', minHeight: 0, alignItems: 'center', justifyContent: 'center' }}>
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
        <div style={{ flex: 1, display: 'flex', minHeight: 0, alignItems: 'center', justifyContent: 'center' }}>
          <EmptyState
            icon={<Icon name="bot" size={40} strokeWidth={1.5} />}
            title={t('chatSession.title')}
            description={t('chatSession.noSession')}
            action={<div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" loading={creating} onClick={() => void createSession()}>
                {t('chatSession.createFirst')}
              </Button>
              <Button variant="ghost" onClick={() => setShowArchive(true)}>
                <Icon name="archive" size={13} />{t('chatSession.viewArchive')}
              </Button>
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
              onClick={() => { setRenameValue(sessionTitle); setRenameError(''); setRenameOpen(true) }}
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
            const sourceEngine = selectedEngine || defaultEngine
            const targetEngine = engineId || defaultEngine
            if (requiresEngineHandoff(
              sourceEngine, targetEngine, messages.length,
              selectedProvider, '',
            )) {
              setHandoffTarget({ engine: targetEngine, providerId: '' })
              setHandoffError('')
              setHandoffOpen(true)
              return
            }
            setSelectedEngine(engineId)
            setSelectedProvider('')
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedVisionModel('')
            setSelectedThinkingEffort('')
          },
          onProviderChange: (providerId) => {
            if (requiresEngineHandoff(
              effectiveEngine, effectiveEngine,
              messages.length, selectedProvider, providerId || '',
              confirmedHandoffMessageCount === messages.length,
            )) {
              setHandoffTarget({
                engine: effectiveEngine,
                providerId: providerId || '',
              })
              setHandoffError('')
              setHandoffOpen(true)
              return
            }
            setSelectedProvider(providerId)
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedVisionModel('')
            setSelectedThinkingEffort('')
          },
          onModelChange: setSelectedModel,
          onFastModelChange: setSelectedFastModel,
          onVisionModelChange: setSelectedVisionModel,
          onThinkingEffortChange: setSelectedThinkingEffort,
          onReset: () => {
            setSelectedEngine('')
            setSelectedProvider('')
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedVisionModel('')
            setSelectedThinkingEffort('')
          },
        }}
        permission={{
          value: permissionMode,
          onChange: (mode) => void changePermissionMode(mode),
        }}
        plan={{
          active: planMode,
          onChange: setPlanMode,
          disabled: running,
        }}
        enhance={enhance}
        context={context}
        quota={visibleQuota}
        onRefreshQuota={() => { void refreshQuota() }}
        quotaRefreshing={quotaRefreshing}
      />

      <ChatSessionForkDialog
        open={forkOpen}
        projectId={activeProject.id}
        sourceTitle={sessionTitle || t('chatSession.title')}
        sourceEngine={selectedEngine || assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai'}
        sourceModel={selectedModel}
        sourceFastModel={selectedFastModel}
        sourceVisionModel={selectedVisionModel}
        sourceProviderId={selectedProvider}
        permissionMode={permissionMode}
        messageCount={forkMessageIndex >= 0 ? forkMessageIndex + 1 : messages.length}
        forkMessageId={forkMessageId}
        forkAtTail={forkMessageIndex < 0 || forkMessageIndex === messages.length - 1}
        engines={sharedEngines}
        providers={providers}
        defaultEngine={assistantConfig?.configured.engine || assistantConfig?.resolved?.engine || 'pydantic_ai'}
        initialTargetEngine={forkTargetEngine}
        loading={forking}
        error={forkError}
        onConfirm={(input) => void forkSession(input)}
        onCancel={() => {
          if (!forking) {
            setForkOpen(false)
            setForkMessageId(null)
          }
        }}
      />

      <ChatEngineHandoffDialog
        open={handoffOpen}
        projectId={activeProject.id}
        source={handoffSource}
        target={handoffTarget ?? { engine: selectedEngine, providerId: selectedProvider }}
        messageCount={messages.length}
        permissionMode={permissionMode}
        sourceProviderLabel={providerLabel(selectedProvider)}
        targetProviderLabel={providerLabel(handoffTarget?.providerId ?? '')}
        loading={handingOff}
        error={handoffError}
        onConfirm={(input) => void handoffSession(input)}
        onCancel={() => {
          if (!handingOff) setHandoffOpen(false)
        }}
      />

      {/* Rename session */}
      <ConfirmDialog
        open={renameOpen}
        title={t('common.rename')}
        confirmText={t('common.save')}
        onConfirm={() => void renameSession()}
        onCancel={() => setRenameOpen(false)}
      >
        <div style={{ padding: '0 20px 4px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => { setRenameValue(e.target.value); setRenameError('') }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void renameSession()
              if (e.key === 'Escape') setRenameOpen(false)
            }}
            placeholder={t('chatSession.renamePlaceholder')}
            style={{ width: '100%' }}
          />
          {renameError && <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)' }}>{renameError}</div>}
        </div>
      </ConfirmDialog>

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
          style={{ justifyContent: 'flex-start', gap: 8 }}
        >
          <Icon name="plus" size={16} /> {t('chatSession.newSession')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setRenameValue(sessionTitle); setRenameError(''); setRenameOpen(true) }}
          style={{ justifyContent: 'flex-start', gap: 8 }}
        >
          <Icon name="pencil" size={16} /> {t('common.rename')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setShowArchive(true) }}
          style={{ justifyContent: 'flex-start', gap: 8 }}
        >
          <Icon name="archive" size={16} /> {t('chatSession.viewArchive')}
        </Button>
        <MobileOpenLocationButton onClick={() => { setMobileMenuOpen(false); setShowMobileDirectoryBrowser(true) }} />
        <ProjectGitButton project={activeProject} />
        <Button
          variant="ghost"
          onClick={() => { setMobileMenuOpen(false); setShowSettingsPanel(true) }}
          style={{ justifyContent: 'flex-start', gap: 8 }}
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
