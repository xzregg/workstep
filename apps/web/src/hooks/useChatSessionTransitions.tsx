import { useCallback, useEffect, useState } from 'react'
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
  engines, providers, permissionMode, onHandoffApplied, navigate, onHandoffSettled,
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
  const [handoffTarget, setHandoffTarget] = useState<HandoffEndpoint | null>(null)
  const messageCount = messageIds.length
  const sourceEngine = current.engine || defaultEngine
  // 连续选择尚未产生新消息时，交接仍以原会话端点为基准。
  const endpointKey = JSON.stringify([project?.id, sessionId, messageCount])
  const [conversationEndpoint, setConversationEndpoint] = useState({
    key: endpointKey, engine: sourceEngine, providerId: current.providerId,
  })
  if (conversationEndpoint.key !== endpointKey) {
    setConversationEndpoint({ key: endpointKey, engine: sourceEngine, providerId: current.providerId })
  }
  const source: HandoffEndpoint = conversationEndpoint

  useEffect(() => {
    setForkOpen(false)
    setHandoffOpen(false)
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
    setHandoffOpen(true)
  }

  const requestEngineHandoff = (targetEngine: string) => {
    if (!requiresEngineHandoff(
      source.engine, targetEngine, messageCount,
    )) return false
    openHandoff({ engine: targetEngine, providerId: '' })
    return true
  }

  const requestProviderHandoff = (providerId: string) => {
    if (!requiresEngineHandoff(
      source.engine, sourceEngine, messageCount, source.providerId, providerId,
    )) return false
    openHandoff({ engine: sourceEngine, providerId })
    return true
  }

  const forkMessageIndex = forkMessageId ? messageIds.indexOf(forkMessageId) : -1
  const providerLabel = (providerId: string) => providerId
    ? providers.find((item) => item.id === providerId)?.name || providerId
    : t('chatSession.providerDefaultLabel')

  const forkSession = async (input: ChatSessionForkInput) => {
    if (!sessionId || !project || forking) return
    setForking(true)
    setForkError('')
    try {
      const detail = await chatSessionApi.fork(sessionId, input)
      useChatListStore.getState().addSession(detail)
      useChatSessionStore.getState().newSession(detail.id)
      setForkOpen(false)
      navigate(`/chat?project=${encodeURIComponent(project.routeName)}&session=${encodeURIComponent(detail.id)}`)
    } catch (reason) {
      setForkError(reason instanceof Error ? reason.message : t('chatSession.forkFailed'))
    } finally {
      setForking(false)
    }
  }

  const handoffSession = async (input: ChatSessionHandoffInput) => {
    if (!sessionId || !project || handingOff) return
    setHandingOff(true)
    setHandoffError('')
    try {
      const detail = await chatSessionApi.handoff(sessionId, input)
      onHandoffApplied(detail)
      setHandoffOpen(false)
      onHandoffSettled?.()
      await useChatListStore.getState().fetchSessions(project.id)
    } catch (reason) {
      setHandoffError(reason instanceof Error ? reason.message : t('chatSession.handoffFailed'))
    } finally {
      setHandingOff(false)
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
      onConfirm={(input) => { void handoffSession(input) }}
      onCancel={() => { if (!handingOff) { setHandoffOpen(false); onHandoffSettled?.() } }}
    />
  </> : null

  return { openFork, requestEngineHandoff, requestProviderHandoff, dialogs }
}
