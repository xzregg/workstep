import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AssistantChatPanel from '../components/AssistantChatPanel'
import Button from '../components/Button'
import ChatEngineHandoffDialog from '../components/ChatEngineHandoffDialog'
import ChatSessionForkDialog from '../components/ChatSessionForkDialog'
import ConfirmDialog from '../components/ConfirmDialog'
import EmptyState from '../components/EmptyState'
import Icon from '../components/Icon'
import Input from '../components/Input'
import MarkdownEditor from '../components/MarkdownEditor'
import PendingMessageInserts, {
  type PendingMessageInsert,
} from '../components/PendingMessageInserts'
import {
  assistantApi,
  chatSessionApi,
  providerApi,
  type AssistantConfigInfo,
  type ChatQuickButton,
  type ChatSessionHandoffInput,
  type ProviderInfo,
  type ChatSessionForkInput,
} from '../api/client'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useProjectStore } from '../stores/projectStore'
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import { useI18n } from '../i18n'
import { clearDraft, loadDraft, saveDraft } from '../utils/chatDraft'
import { clearInsertQueue, loadInsertQueue, saveInsertQueue } from '../utils/chatInsertQueue'
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

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function ChatPage() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectParam = searchParams.get('project')
  const workflowParam = searchParams.get('workflow')
  const sessionParam = searchParams.get('session')

  const { activeProject, fetchProjects, setActiveProject, setActiveWorkflow } = useProjectStore()

  const [sessionId, setSessionId] = useState<string | null>(sessionParam)
  const prevSessionIdRef = useRef<string | null>(null)
  const [sessionTitle, setSessionTitle] = useState('')
  const [input, setInput] = useState('')
  const [sendError, setSendError] = useState('')
  const [pendingInserts, setPendingInserts] = useState<PendingMessageInsert[]>([])
  const [editingInsertId, setEditingInsertId] = useState<string | null>(null)
  const [editingInsertContent, setEditingInsertContent] = useState('')
  const [sendingInsertIds, setSendingInsertIds] = useState<string[]>([])
  const [stopping, setStopping] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState('')
  const [forkTargetEngine, setForkTargetEngine] = useState('')
  const [forkMessageId, setForkMessageId] = useState<string | null>(null)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handingOff, setHandingOff] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [handoffTargetEngine, setHandoffTargetEngine] = useState('')
  const [quickEditOpen, setQuickEditOpen] = useState(false)
  const [quickDraft, setQuickDraft] = useState<ChatQuickButton[]>([])
  const [quickError, setQuickError] = useState('')
  const [quickSaving, setQuickSaving] = useState(false)
  const [quickRemoveId, setQuickRemoveId] = useState<string | null>(null)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [promptEditOpen, setPromptEditOpen] = useState(false)
  const [promptDraft, setPromptDraft] = useState('')
  const [promptError, setPromptError] = useState('')
  const [promptSaving, setPromptSaving] = useState(false)

  // Engine/model picker (session-scoped, mirrors the flow assistant wiring).
  const [assistantConfig, setAssistantConfig] = useState<AssistantConfigInfo | null>(null)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [selectedEngine, setSelectedEngine] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedFastModel, setSelectedFastModel] = useState('')
  const [selectedVisionModel, setSelectedVisionModel] = useState('')
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState('')
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
  const context = useMemo(
    () => contextUsageFromMessages(messages),
    [messages],
  )
  const forkMessageIndex = forkMessageId
    ? messages.findIndex((message) => message.id === forkMessageId)
    : -1
  const quickButtons = useChatListStore((s) => s.quickButtons)

  // Resolve project/workflow from the URL (mirrors CanvasEditor's loader).
  useEffect(() => {
    if (!projectParam) return
    const doLoad = async () => {
      await fetchProjects()
      const currentProjects = useProjectStore.getState().projects
      const match = currentProjects.find((p) => p.name === projectParam)
      if (match) {
        setActiveProject(match)
        const targetWf = workflowParam
          ? match.workflows?.find((w) => w.id === workflowParam)
          : match.workflows?.find((w) => w.is_default) || match.workflows?.[0]
        if (targetWf) setActiveWorkflow(targetWf.id)
      }
    }
    void doLoad()
  }, [projectParam, workflowParam, fetchProjects, setActiveProject, setActiveWorkflow])

  // Engine defaults + per-project quick buttons.
  // Only re-fetch when the project changes; session switching does not affect config.
  useEffect(() => {
    let active = true
    if (!activeProject?.id) return
    assistantApi.list()
      .then(({ assistants }) => {
        if (!active) return
        const config = assistants.find((item) => item.name === 'chat_session')
        if (!config) throw new Error(t('chatSession.configLoadFailed'))
        setAssistantConfig(config)
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

  useEffect(() => {
    if (!activeProject?.id) return
    let active = true
    chatSessionApi.getSystemPrompt(activeProject.id)
      .then((result) => {
        if (active) {
          setSystemPrompt(result.prompt)
          setDefaultPrompt(result.default_prompt)
        }
      })
      .catch(() => { /* keep the last known prompt */ })
    return () => { active = false }
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
        )
      })
      .catch(() => {
        if (!active) return
        // Session was deleted elsewhere — drop the invalid id from the URL.
        navigate(`/chat?project=${encodeURIComponent(projectParam || '')}`, { replace: true })
      })
    return () => { active = false }
  }, [sessionParam, activeProject?.id, projectParam, workflowParam, navigate, resetEnhance])

  // Keep the sidebar session list fresh (titles/previews after turns).
  useEffect(() => {
    if (!activeProject?.id) return
    void useChatListStore.getState().fetchSessions(activeProject.id)
  }, [activeProject?.id, running])

  // Reset transient state when switching sessions.
  // Save the previous session's input to localStorage before clearing,
  // then restore the target session's draft (if any).
  useEffect(() => {
    const prevId = prevSessionIdRef.current
    if (prevId && input.trim()) {
      saveDraft(activeProject?.id ?? '', prevId, input)
    }
    prevSessionIdRef.current = sessionId
    if (sessionId && activeProject?.id) {
      const draft = loadDraft(activeProject.id, sessionId)
      setInput(draft)
    } else {
      setInput('')
    }
    setSendError('')
    setStopping(false)
    setPendingInserts([])
    setEditingInsertId(null)
    setEditingInsertContent('')
    setSendingInsertIds([])
  }, [sessionId])

  // ── 插入队列持久化 ─────────────────────────────
  // localStorage 按（项目, 会话）保存队列，刷新页面后恢复。
  // queueStorageRef 记录当前生效 key，写回只跟随队列内容变化，
  // 避免会话切换瞬间把旧队列错写到新会话的 key 上。
  const queueStorageRef = useRef<{ projectId: string; sessionId: string } | null>(null)

  useEffect(() => {
    queueStorageRef.current = sessionId && activeProject?.id
      ? { projectId: activeProject.id, sessionId }
      : null
  }, [sessionId, activeProject?.id])

  // 恢复队列：刷新页面时 activeProject 异步加载完成后再恢复；
  // 切换会话时在 reset effect 清空后恢复目标会话的队列。
  useEffect(() => {
    if (!sessionId || !activeProject?.id) return
    setPendingInserts(loadInsertQueue(activeProject.id, sessionId))
  }, [sessionId, activeProject?.id])

  useEffect(() => {
    const target = queueStorageRef.current
    if (!target) return
    saveInsertQueue(target.projectId, target.sessionId, pendingInserts)
  }, [pendingInserts])

  const sendMessageNow = useCallback(async (content: string): Promise<boolean> => {
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return false
    }
    if (!activeProject?.id) return false
    setSendError('')
    try {
      useChatSessionStore.getState().addUserMessage(sessionId, content)
      const accepted = await chatSessionApi.chat(sessionId, activeProject.id, content, randomId(), {
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

  const send = useCallback(async (contentOverride?: string) => {
    const content = (contentOverride ?? input).trim()
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return
    }
    if (running) {
      setPendingInserts((current) => [
        ...current,
        { id: `insert-${randomId()}`, content },
      ])
      setInput('')
      clearDraft(activeProject?.id ?? '', sessionId)
      setSendError('')
      resetEnhance()
      return
    }
    setInput('')
    clearDraft(activeProject?.id ?? '', sessionId)
    resetEnhance()
    await sendMessageNow(content)
  }, [input, running, sessionId, activeProject?.id, sendMessageNow, t, resetEnhance])

  const sendPendingInserts = useCallback(async (items: PendingMessageInsert[]) => {
    if (
      items.length === 0
      || sendingInsertIds.length > 0
      || !sessionId
      || !activeProject?.id
    ) return
    const ids = items.map((item) => item.id)
    setSendingInsertIds(ids)
    setSendError('')
    const content = items.map((item) => item.content).join('\n\n')
    // 引擎已完成（竞态：用户输入时 running，点击发送时已结束）→ 降级为新 turn
    if (!running) {
      const ok = await sendMessageNow(content)
      if (ok) {
        setPendingInserts((current) => current.filter((item) => !ids.includes(item.id)))
        setEditingInsertId(null)
        setEditingInsertContent('')
      }
      setSendingInsertIds([])
      return
    }
    try {
      await chatSessionApi.sendLiveMessage(
        sessionId,
        activeProject.id,
        content,
      )
      setPendingInserts((current) => current.filter((item) => !ids.includes(item.id)))
      setEditingInsertId(null)
      setEditingInsertContent('')
    } catch (reason) {
      const msg = reason instanceof Error ? reason.message : ''
      if (msg.includes('not running')) {
        // 后端也认为已结束 → 降级为新 turn
        const ok = await sendMessageNow(content)
        if (ok) {
          setPendingInserts((current) => current.filter((item) => !ids.includes(item.id)))
          setEditingInsertId(null)
          setEditingInsertContent('')
        }
      } else {
        setSendError(msg || t('chatSession.sendFailed'))
      }
    } finally {
      setSendingInsertIds([])
    }
  }, [activeProject?.id, running, sendingInsertIds.length, sessionId, sendMessageNow, t])

  const savePendingInsertEdit = useCallback((insertId: string) => {
    const content = editingInsertContent.trim()
    if (!content) return
    setPendingInserts((current) => current.map((item) => (
      item.id === insertId ? { ...item, content } : item
    )))
    setEditingInsertId(null)
    setEditingInsertContent('')
  }, [editingInsertContent])

  // ── 插入队列自动推进 ─────────────────────────────
  // 引擎执行中插入的消息先排队；当前执行结束（running: true → false）时，
  // 自动发送队首消息触发下一轮执行，直至队列清空。
  // autoDrainingRef 防止同一空闲窗口内重复发送；编辑中不自动发送，避免覆盖用户编辑。
  const prevRunningRef = useRef(running)
  const autoDrainingRef = useRef(false)

  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = running
    if (!wasRunning || running || autoDrainingRef.current) return
    if (!sessionId || !activeProject?.id || editingInsertId !== null) return
    if (pendingInserts.length === 0 || sendingInsertIds.length > 0) return
    const first = pendingInserts[0]
    autoDrainingRef.current = true
    setSendingInsertIds([first.id])
    setSendError('')
    void sendMessageNow(first.content).then((ok) => {
      if (ok) {
        setPendingInserts((current) => current.filter((item) => item.id !== first.id))
        setEditingInsertId(null)
        setEditingInsertContent('')
      }
      setSendingInsertIds([])
      autoDrainingRef.current = false
    })
  }, [running, pendingInserts, editingInsertId, sendingInsertIds.length, sessionId, activeProject?.id, sendMessageNow])

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
      const detail = await chatSessionApi.create({
        project_id: activeProject.id,
        engine: selectedEngine || undefined,
        provider_id: selectedProvider || undefined,
        model: selectedModel || undefined,
        fast_model: selectedFastModel || undefined,
        vision_model: selectedVisionModel || undefined,
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
  }, [activeProject, creating, selectedEngine, selectedProvider, selectedModel, selectedFastModel, selectedVisionModel, projectParam, navigate, t])

  const openFork = useCallback((targetEngine = selectedEngine, messageId: string | null = null) => {
    if (!sessionId || running) return
    setForkTargetEngine(targetEngine || selectedEngine)
    setForkMessageId(messageId)
    setForkError('')
    setForkOpen(true)
  }, [sessionId, running, selectedEngine])

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
      setHandoffOpen(false)
      await useChatListStore.getState().fetchSessions(activeProject.id)
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : t('chatSession.handoffFailed'))
    } finally {
      setHandingOff(false)
    }
  }, [sessionId, activeProject?.id, handingOff, t])

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

  const deleteSession = useCallback(async () => {
    if (!activeProject?.id || !sessionId || deleting || running) return
    setDeleting(true)
    setSendError('')
    try {
      await chatSessionApi.remove(sessionId, activeProject.id)
      useChatSessionStore.getState().resetSession(sessionId)
      useChatListStore.getState().removeSession(sessionId)
      clearInsertQueue(activeProject.id, sessionId)
      setDeleteOpen(false)
      navigate(`/chat?project=${encodeURIComponent(projectParam || activeProject?.name || '')}`, { replace: true })
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('chatSession.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }, [activeProject, sessionId, deleting, running, projectParam, navigate, t])

  const openQuickEdit = () => {
    setQuickDraft(quickButtons.length > 0 ? quickButtons.map((b) => ({ ...b })) : [{ id: randomId(), label: '', prompt: '' }])
    setQuickError('')
    setQuickEditOpen(true)
  }

  const saveQuickButtons = useCallback(async () => {
    if (!activeProject?.id || quickSaving) return
    for (const button of quickDraft) {
      if (!button.label.trim()) {
        setQuickError(t('chatSession.buttonLabelRequired'))
        return
      }
      if (!button.prompt.trim()) {
        setQuickError(t('chatSession.buttonPromptRequired'))
        return
      }
    }
    setQuickSaving(true)
    setQuickError('')
    try {
      await useChatListStore.getState().saveQuickButtons(
        activeProject.id,
        quickDraft.map((b) => ({ id: b.id, label: b.label.trim(), prompt: b.prompt.trim() })),
      )
      setQuickEditOpen(false)
    } catch (reason) {
      setQuickError(reason instanceof Error ? reason.message : t('chatSession.buttonsSaved'))
    } finally {
      setQuickSaving(false)
    }
  }, [activeProject?.id, quickDraft, quickSaving, t])

  const openPromptEdit = () => {
    setPromptDraft(systemPrompt)
    setPromptError('')
    setPromptEditOpen(true)
  }

  const saveSystemPrompt = useCallback(async () => {
    if (!activeProject?.id || promptSaving) return
    setPromptSaving(true)
    setPromptError('')
    try {
      const result = await chatSessionApi.saveSystemPrompt(activeProject.id, promptDraft)
      setSystemPrompt(result.prompt)
      setPromptEditOpen(false)
    } catch (reason) {
      setPromptError(reason instanceof Error ? reason.message : t('chatSession.promptSaveFailed'))
    } finally {
      setPromptSaving(false)
    }
  }, [activeProject?.id, promptDraft, promptSaving, t])

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
      <div style={{ flex: 1, display: 'flex', minHeight: 0, alignItems: 'center', justifyContent: 'center' }}>
        <EmptyState
          icon={<Icon name="bot" size={40} strokeWidth={1.5} />}
          title={t('chatSession.title')}
          description={t('chatSession.noSession')}
          action={(
            <Button variant="primary" loading={creating} onClick={() => void createSession()}>
              {t('chatSession.createFirst')}
            </Button>
          )}
        />
      </div>
    )
  }

  return (
    <>
      <AssistantChatPanel
        projectId={activeProject.id}
        sessionId={sessionId}
        title={sessionTitle || t('chatSession.title')}
        messages={messages}
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
        onStop={() => void stop()}
        allowSendWhileRunning
        composerOverlay={(
          <PendingMessageInserts
            items={pendingInserts}
            title={t('chatSession.pendingInsertTitle')}
            titleTooltip={t('chatSession.pendingInsertHint')}
            editingId={editingInsertId}
            editingContent={editingInsertContent}
            sendingIds={sendingInsertIds}
            onEditingContentChange={setEditingInsertContent}
            onEditStart={(item) => {
              setEditingInsertId(item.id)
              setEditingInsertContent(item.content)
            }}
            onEditSave={savePendingInsertEdit}
            onEditCancel={() => {
              setEditingInsertId(null)
              setEditingInsertContent('')
            }}
            onSend={(item) => void sendPendingInserts([item])}
            onRemove={(id) => setPendingInserts((current) => (
              current.filter((item) => item.id !== id)
            ))}
            onSendAll={() => void sendPendingInserts(pendingInserts)}
            onClear={() => setPendingInserts([])}
            onReorder={(fromIndex, toIndex) => setPendingInserts((current) => {
              if (
                fromIndex === toIndex
                || fromIndex < 0 || fromIndex >= current.length
                || toIndex < 0 || toIndex >= current.length
              ) return current
              const next = [...current]
              const [moved] = next.splice(fromIndex, 1)
              next.splice(toIndex, 0, moved)
              return next
            })}
            reorderHint={t('chatSession.pendingInsertReorderHint')}
          />
        )}
        onAttachmentError={setSendError}
        onLoadMessageEvents={(messageId) => void loadMessageEvents(messageId)}
        onForkMessage={(messageId) => openFork(selectedEngine, messageId)}
        quickPromptsLabel={t('chatSession.quickPromptsLabel')}
        quickPrompts={quickButtons.map((button) => ({ label: button.label, prompt: button.prompt }))}
        onQuickPromptSelect={(prompt) => {
          setInput((current) => applyAssistantQuickPrompt(current, prompt))
          setSendError('')
        }}
        copy={{
          emptyIntro: t('chatSession.emptyIntro'),
          thinking: t('chatSession.thinking'),
          me: t('chatSession.me'),
          meInitials: t('chatSession.meInitials'),
          agent: t('chatSession.agent'),
          agentInitials: t('chatSession.agentInitials'),
          placeholder: t('chatSession.placeholder'),
          fullPrompt: t('aiFlow.fullPrompt'),
          closePrompt: t('aiFlow.closePrompt'),
        }}
        headerActions={(
          <>
            <Button
              variant="ghost"
              size="sm"
              title={t('chatSession.manageQuickButtons')}
              onClick={openQuickEdit}
            >
              {t('chatSession.manageQuickButtons')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title={t('chatSession.manageSystemPrompt')}
              onClick={openPromptEdit}
            >
              {t('chatSession.manageSystemPrompt')}
            </Button>
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
              disabled={running}
              title={running ? t('chatSession.runningDeleteHint') : t('common.delete')}
              onClick={() => setDeleteOpen(true)}
              style={{ color: 'var(--danger)' }}
            >
              {t('common.delete')}
            </Button>
          </>
        )}
        config={{
          projectId: activeProject.id,
          engines: assistantConfig?.available_engines || [],
          engine: selectedEngine,
          providers,
          providerId: selectedProvider,
          defaultEngine: assistantConfig?.configured.engine || 'claude',
          model: selectedModel,
          fastModel: selectedFastModel,
          visionModel: selectedVisionModel,
          showVision: true,
          thinkingEffort: selectedThinkingEffort,
          disabled: !assistantConfig || coordinatorConfigError !== '' || running,
          error: coordinatorConfigError,
          hint: assistantConfig ? t('chatSession.sessionHint') : '',
          engineTitle: t('chatSession.engineTitle'),
          onEngineChange: (engineId) => {
            const defaultEngine = assistantConfig?.configured.engine || 'claude'
            const sourceEngine = selectedEngine || defaultEngine
            const targetEngine = engineId || defaultEngine
            if (requiresEngineHandoff(sourceEngine, targetEngine, messages.length)) {
              setHandoffTargetEngine(targetEngine)
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
          onChange: setPermissionMode,
          disabled: running,
        }}
        plan={{
          active: planMode,
          onChange: setPlanMode,
          disabled: running,
        }}
        enhance={enhance}
        context={context}
      />

      <ChatSessionForkDialog
        open={forkOpen}
        projectId={activeProject.id}
        sourceTitle={sessionTitle || t('chatSession.title')}
        sourceEngine={selectedEngine || assistantConfig?.configured.engine || 'claude'}
        sourceModel={selectedModel}
        sourceFastModel={selectedFastModel}
        sourceVisionModel={selectedVisionModel}
        sourceProviderId={selectedProvider}
        permissionMode={permissionMode}
        messageCount={forkMessageIndex >= 0 ? forkMessageIndex + 1 : messages.length}
        forkMessageId={forkMessageId}
        forkAtTail={forkMessageIndex < 0 || forkMessageIndex === messages.length - 1}
        engines={assistantConfig?.available_engines || []}
        providers={providers}
        defaultEngine={assistantConfig?.configured.engine || 'claude'}
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
        sourceEngine={selectedEngine || assistantConfig?.configured.engine || 'claude'}
        targetEngine={handoffTargetEngine}
        messageCount={messages.length}
        permissionMode={permissionMode}
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

      {/* Delete session */}
      <ConfirmDialog
        open={deleteOpen}
        title={t('chatSession.deleteTitle')}
        message={t('chatSession.deleteMessage', { title: sessionTitle || t('chatSession.title') })}
        confirmText={t('chatSession.deleteConfirm')}
        danger
        loading={deleting}
        onConfirm={() => void deleteSession()}
        onCancel={() => setDeleteOpen(false)}
      />

      {/* Quick buttons editor */}
      <ConfirmDialog
        open={quickEditOpen}
        title={t('chatSession.manageQuickButtonsTitle')}
        confirmText={t('chatSession.saveButtons')}
        loading={quickSaving}
        width={820}
        onConfirm={() => void saveQuickButtons()}
        onCancel={() => setQuickEditOpen(false)}
      >
        <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '65vh', overflowY: 'auto' }}>
          {quickDraft.map((button, index) => (
            <div key={button.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <Input
                  value={button.label}
                  onChange={(e) => {
                    const next = [...quickDraft]
                    next[index] = { ...button, label: e.target.value }
                    setQuickDraft(next)
                    setQuickError('')
                  }}
                  placeholder={t('chatSession.buttonLabel')}
                  style={{ width: '100%' }}
                />
                <MarkdownEditor
                  value={button.prompt}
                  onChange={(value) => {
                    const next = [...quickDraft]
                    next[index] = { ...button, prompt: value }
                    setQuickDraft(next)
                    setQuickError('')
                  }}
                  projectId={activeProject?.id}
                  imagePrefix="quick-button"
                  placeholder={t('chatSession.buttonPrompt')}
                  minHeight={120}
                  maxHeight={220}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (quickDraft.length <= 1) return
                  setQuickRemoveId(button.id)
                }}
                style={{ color: 'var(--danger)', flexShrink: 0 }}
              >
                <Icon name="trash" size={14} />
              </Button>
            </div>
          ))}
          {quickError && <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)' }}>{quickError}</div>}
          <Button variant="ghost" size="sm" onClick={() => {
            setQuickDraft([...quickDraft, { id: randomId(), label: '', prompt: '' }])
            setQuickError('')
          }}>
            {t('chatSession.addButton')}
          </Button>
        </div>
      </ConfirmDialog>

      {/* System prompt editor */}
      <ConfirmDialog
        open={promptEditOpen}
        title={t('chatSession.manageSystemPromptTitle')}
        confirmText={t('common.save')}
        loading={promptSaving}
        width={820}
        onConfirm={() => void saveSystemPrompt()}
        onCancel={() => setPromptEditOpen(false)}
      >
        <div style={{ padding: '0 20px 4px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <MarkdownEditor
            autoFocus
            value={promptDraft}
            onChange={(value) => { setPromptDraft(value); setPromptError('') }}
            projectId={activeProject?.id}
            imagePrefix="system-prompt"
            placeholder={t('chatSession.systemPromptPlaceholder')}
            minHeight={420}
            maxHeight="55vh"
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)' }}>{t('chatSession.systemPromptHint')}</div>
            <button
              onClick={() => { setPromptDraft(defaultPrompt); setPromptError('') }}
              style={{
                fontSize: 'calc(12px * var(--font-scale))',
                color: 'var(--accent)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                whiteSpace: 'nowrap',
              }}
            >
              {t('chatSession.loadDefaultPrompt')}
            </button>
          </div>
          {promptError && <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--danger)' }}>{promptError}</div>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={quickRemoveId !== null}
        title={t('common.delete')}
        message={t('chatSession.manageQuickButtonsTitle')}
        danger
        onConfirm={() => {
          if (quickRemoveId) setQuickDraft((draft) => draft.filter((b) => b.id !== quickRemoveId))
          setQuickRemoveId(null)
        }}
        onCancel={() => setQuickRemoveId(null)}
      />
    </>
  )
}
