import { useCallback, useEffect, useRef, useState } from 'react'
import {
  chatSessionApi,
  type ChatSessionDetail,
  type ChatSessionForkInput,
  type ChatSessionHandoffInput,
  type CoordinatorEngineSummary,
  type ProviderInfo,
} from '../api/client'
import ChatEngineHandoffDialog, { type HandoffEndpoint } from '../components/ChatEngineHandoffDialog'
import ChatSessionForkDialog from '../components/ChatSessionForkDialog'
import { useI18n } from '../i18n'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import type { ChatEngineConfigState } from '../utils/chatEngineConfig'
import { requiresEngineHandoff } from '../utils/chatSessionFork'

interface TransitionOptions {
  project: { id: string; routeName: string } | null
  sessionId: string | null
  sessionTitle: string
  messageIds: string[]
  running: boolean
  current: ChatEngineConfigState
  pendingHandoff?: ChatSessionDetail['pending_handoff']
  loadedEndpoint?: HandoffEndpoint | null
  defaultEngine: string
  engines: CoordinatorEngineSummary[]
  providers: ProviderInfo[]
  permissionMode: string
  onHandoffApplied: (detail: ChatSessionDetail) => void
  navigate: (path: string) => void
  onHandoffSettled?: () => void
}

/** Owns fork and handoff prompts, requests, errors and successful session updates. */
export function useChatSessionTransitions({
  project, sessionId, sessionTitle, messageIds, running, current, defaultEngine,
  engines, providers, permissionMode, onHandoffApplied, navigate, onHandoffSettled, pendingHandoff, loadedEndpoint,
}: TransitionOptions) {
  const { t } = useI18n()
  const [forkOpen, setForkOpen] = useState(false)
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState('')
  const [forkTargetEngine, setForkTargetEngine] = useState('')
  const [forkMessageId, setForkMessageId] = useState<string | null>(null)
  const [forkPreferSmart, setForkPreferSmart] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handingOff, setHandingOff] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [handoffMode, setHandoffMode] = useState<ChatSessionHandoffInput['context_mode']>('smart')
  const [handoffTarget, setHandoffTarget] = useState<HandoffEndpoint | null>(null)
  const scopeKey = JSON.stringify([project?.id, sessionId])
  const scopeRef = useRef({ key: scopeKey })
  if (scopeRef.current.key !== scopeKey) scopeRef.current = { key: scopeKey }
  const messageCount = messageIds.length
  const sourceEngine = current.engine || defaultEngine
  // 连续选择尚未产生新消息时，交接仍以原会话端点为基准。
  const tailMessageId = messageIds.at(-1) ?? null
  const endpointKey = JSON.stringify([project?.id, sessionId, tailMessageId])
  const confirmedHandoff = useRef<{
    scope: typeof scopeRef.current; endpointKey: string; engine: string; mode: ChatSessionHandoffInput['context_mode']
  } | null>(null)
  const requestScope = useRef<typeof scopeRef.current | null>(null)
  const [conversationEndpoint, setConversationEndpoint] = useState({
    key: endpointKey, engine: loadedEndpoint?.engine || sourceEngine,
    providerId: loadedEndpoint?.providerId ?? current.providerId, loadedEndpoint,
  })
  if (conversationEndpoint.key !== endpointKey || conversationEndpoint.loadedEndpoint !== loadedEndpoint) {
    const endpoint = conversationEndpoint.loadedEndpoint !== loadedEndpoint && loadedEndpoint
      ? loadedEndpoint : { engine: sourceEngine, providerId: current.providerId }
    setConversationEndpoint({ key: endpointKey, ...endpoint, loadedEndpoint })
  }
  const persistedPending = pendingHandoff?.message_id === tailMessageId ? pendingHandoff : null
  const source: HandoffEndpoint = persistedPending
    ? { engine: persistedPending.source_engine, providerId: persistedPending.source_provider_id }
    : conversationEndpoint
  const confirmed = confirmedHandoff.current
  const confirmedMode = persistedPending?.target_engine === sourceEngine ? persistedPending.context_mode
    : confirmed?.scope === scopeRef.current && confirmed.endpointKey === endpointKey && confirmed.engine === sourceEngine
      ? confirmed.mode : null

  useEffect(() => {
    setForkOpen(false)
    setHandoffOpen(false)
    setForking(false)
    setHandingOff(false)
    setForkError('')
    setHandoffError('')
    setHandoffTarget(null)
  }, [project?.id, sessionId])

  const openFork = useCallback((targetEngine = current.engine, messageId: string | null = null, preferSmart = false) => {
    if (!sessionId || (running && !messageId)) return
    setForkTargetEngine(targetEngine || current.engine)
    setForkMessageId(messageId)
    setForkPreferSmart(preferSmart || running)
    setForkError('')
    setForkOpen(true)
  }, [current.engine, running, sessionId])

  const openHandoff = (target: HandoffEndpoint) => {
    setHandoffTarget(target)
    setHandoffError('')
    setHandoffMode('smart')
    setHandoffOpen(true)
  }

  const requestEngineHandoff = (targetEngine: string, providerOverride?: string) => {
    if (running || requestScope.current === scopeRef.current) return true
    if (targetEngine === sourceEngine) return providerOverride === undefined ? false : requestProviderHandoff(providerOverride)
    const providerId = providerOverride ?? (targetEngine === source.engine ? source.providerId : '')
    if (targetEngine === source.engine && providerId === source.providerId && sessionId && project) {
      void handoffSession({ project_id: project.id, engine: targetEngine,
        provider_id: providerId, context_mode: confirmedMode || 'smart' }, true)
      return true
    }
    if (!requiresEngineHandoff(
      source.engine, targetEngine, messageCount, source.providerId, providerId,
    )) {
      if (sessionId && project && messageCount === 0) {
        void handoffSession({ project_id: project.id, engine: targetEngine, provider_id: providerId, context_mode: 'none' }, true)
        return true
      }
      return false
    }
    openHandoff({ engine: targetEngine, providerId })
    return true
  }

  const requestProviderHandoff = (providerId: string) => {
    if (running || requestScope.current === scopeRef.current) return true
    if (providerId === current.providerId) return false
    // 交接后尚未发送新消息：供应商仍是本次目标配置的一部分，复用已选的上下文。
    if (sessionId && project && (confirmedMode || (source.engine === sourceEngine && providerId === source.providerId))) {
      void handoffSession({ project_id: project.id, engine: sourceEngine, provider_id: providerId,
        context_mode: confirmedMode || 'smart' }, true)
      return true
    }
    if (!requiresEngineHandoff(
      source.engine, sourceEngine, messageCount, source.providerId, providerId,
    )) {
      if (sessionId && project && messageCount === 0) {
        void handoffSession({ project_id: project.id, engine: sourceEngine, provider_id: providerId, context_mode: 'none' }, true)
        return true
      }
      return false
    }
    openHandoff({ engine: sourceEngine, providerId })
    return true
  }

  const forkMessageIndex = forkMessageId ? messageIds.indexOf(forkMessageId) : -1
  const providerLabel = (providerId: string) => providerId
    ? providers.find((item) => item.id === providerId)?.name || providerId
    : t('chatSession.providerDefaultLabel')

  const forkSession = async (input: ChatSessionForkInput) => {
    if (!sessionId || !project || forking) return
    const scope = scopeRef.current
    setForking(true)
    setForkError('')
    try {
      const detail = await chatSessionApi.fork(sessionId, input)
      if (scopeRef.current !== scope) return
      useChatListStore.getState().addSession(detail)
      useChatSessionStore.getState().newSession(detail.id)
      setForkOpen(false)
      navigate(`/chat?project=${encodeURIComponent(project.routeName)}&session=${encodeURIComponent(detail.id)}`)
    } catch (reason) {
      if (scopeRef.current !== scope) return
      setForkError(reason instanceof Error ? reason.message : t('chatSession.forkFailed'))
    } finally {
      if (scopeRef.current === scope) setForking(false)
    }
  }

  const handoffSession = async (input: ChatSessionHandoffInput, silent = false) => {
    if (!sessionId || !project || running || requestScope.current === scopeRef.current) return
    const scope = scopeRef.current
    requestScope.current = scope
    setHandingOff(true)
    setHandoffError('')
    try {
      const detail = await chatSessionApi.handoff(sessionId, input)
      if (scopeRef.current !== scope) return
      confirmedHandoff.current = detail.engine === source.engine && (detail.provider_id || '') === source.providerId
        ? null : { scope, endpointKey, engine: detail.engine, mode: input.context_mode }
      onHandoffApplied(detail)
      setHandoffOpen(false)
      onHandoffSettled?.()
      await useChatListStore.getState().fetchSessions(project.id)
    } catch (reason) {
      if (scopeRef.current !== scope) return
      setHandoffError(reason instanceof Error ? reason.message : t('chatSession.handoffFailed'))
      if (silent) {
        setHandoffMode(input.context_mode)
        setHandoffTarget({ engine: input.engine, providerId: input.provider_id || '' })
        setHandoffOpen(true)
      }
    } finally {
      if (requestScope.current === scope) requestScope.current = null
      if (scopeRef.current === scope) setHandingOff(false)
    }
  }

  const dialogs = project && sessionId ? <>
    <ChatSessionForkDialog
      open={forkOpen}
      projectId={project.id}
      sourceTitle={sessionTitle || t('chatSession.title')}
      sourceEngine={sourceEngine}
      sourceModel={current.model}
      sourceFastModel={current.fastModel}
      sourceVisionModel={current.visionModel}
      sourceProviderId={current.providerId}
      permissionMode={permissionMode}
      messageCount={forkMessageIndex >= 0 ? forkMessageIndex + 1 : messageCount}
      forkMessageId={forkMessageId}
      preferSmart={forkPreferSmart}
      forkAtTail={!running && (forkMessageIndex < 0 || forkMessageIndex === messageCount - 1)}
      engines={engines}
      providers={providers}
      defaultEngine={defaultEngine}
      initialTargetEngine={forkTargetEngine}
      loading={forking}
      error={forkError}
      onConfirm={(input) => { void forkSession(input) }}
      onCancel={() => {
        if (!forking) {
          setForkOpen(false)
          setForkMessageId(null)
        }
      }}
    />
    <ChatEngineHandoffDialog
      open={handoffOpen}
      projectId={project.id}
      source={source}
      target={handoffTarget ?? source}
      messageCount={messageCount}
      permissionMode={permissionMode}
      sourceProviderLabel={providerLabel(source.providerId)}
      targetProviderLabel={providerLabel(handoffTarget?.providerId ?? '')}
      loading={handingOff}
      error={handoffError}
      initialMode={handoffMode}
      onConfirm={(input) => { void handoffSession(input) }}
      onCancel={() => { if (!handingOff) { setHandoffOpen(false); onHandoffSettled?.() } }}
    />
  </> : null

  return { openFork, requestEngineHandoff, requestProviderHandoff,
    requestResetHandoff: () => requestEngineHandoff(defaultEngine, ''), handingOff, dialogs }
}
