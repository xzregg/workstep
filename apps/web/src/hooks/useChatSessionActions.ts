import { useCallback, useEffect, useState } from 'react'
import { ApiError, chatSessionApi } from '../api/client'
import { useI18n } from '../i18n'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import type { ChatEngineConfigState } from '../utils/chatEngineConfig'
import { randomUuid } from '../utils/uuid'
import { watchPendingCompletion, unwatchPendingCompletion, watchAcceptedCompletion } from '../utils/completionNotifications'
import { flushWsSubscriptionNow } from './useWebSocket'

interface Options {
  sessionId: string | null
  projectId?: string
  running: boolean
  engineConfig: ChatEngineConfigState
  permissionMode: string
  planMode: boolean
  goalMode: boolean
  effectiveEngine: string
  onSessionIdChange: (id: string) => void
  onTitleChange: (title: string) => void
}

/** Owns a chat turn's send, live-insert, stop and error recovery lifecycle. */
export function useChatSessionActions({
  sessionId, projectId, running, engineConfig, permissionMode, planMode,
  goalMode, effectiveEngine, onSessionIdChange, onTitleChange,
}: Options) {
  const { t } = useI18n()
  const [sendError, setSendError] = useState('')
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    setSendError('')
    setStopping(false)
  }, [sessionId, projectId])

  const sendMessageNow = useCallback(async (content: string, goalCommand = false): Promise<boolean> => {
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return false
    }
    if (!projectId) return false
    setSendError('')
    // 先记乐观 id：彻底失败时撤掉气泡，不留后端不存在的幻影消息。
    const optimisticId = useChatSessionStore.getState().addUserMessage(sessionId, content)
    flushWsSubscriptionNow()
    watchPendingCompletion(projectId, { sessionId })
    try {
      const accepted = await chatSessionApi.chat(sessionId, projectId, content, randomUuid(), {
        engine: engineConfig.engine || undefined,
        provider_id: engineConfig.providerId || (engineConfig.providerCleared ? '' : undefined),
        model: engineConfig.model || undefined,
        fast_model: engineConfig.fastModel || undefined,
        vision_model: engineConfig.visionModel || undefined,
        thinking_effort: engineConfig.thinkingEffort || undefined,
        permission_mode: permissionMode || undefined,
        plan_mode: goalCommand ? false : planMode || undefined,
        goal_mode: goalCommand ? false : goalMode && effectiveEngine === 'codex_sdk' || undefined,
      })
      if (accepted.session_id && accepted.session_id !== sessionId) {
        const store = useChatSessionStore.getState()
        const oldSession = store.sessions[sessionId]
        store.newSession(accepted.session_id)
        if (oldSession) {
          useChatSessionStore.setState((state) => ({
            sessions: { ...state.sessions, [accepted.session_id]: oldSession },
          }))
          store.resetSession(sessionId)
        }
        onSessionIdChange(accepted.session_id)
      }
      const finalSessionId = accepted.session_id || sessionId
      useChatSessionStore.getState().confirmUserMessage(finalSessionId, optimisticId, accepted.turn_id)
      useChatSessionStore.getState().acceptAssistantReply(finalSessionId, accepted.assistant_message_id, {
        engine: engineConfig.engine || effectiveEngine, model: engineConfig.model || undefined,
        status: accepted.status,
      })
      if (finalSessionId !== sessionId) {
        unwatchPendingCompletion(projectId, { sessionId })
        watchPendingCompletion(projectId, { sessionId: finalSessionId })
      }
      watchAcceptedCompletion(projectId, { sessionId: finalSessionId }, accepted.assistant_message_id)
      // The turn is already accepted. A catalog refresh cannot fail that send
      // or keep the composer waiting for a separate network request.
      void chatSessionApi.list(projectId).then(({ sessions }) => {
        const summary = sessions.find((item) => item.id === finalSessionId)
        if (summary?.title) {
          onTitleChange(summary.title)
          useChatListStore.getState().renameSession(finalSessionId, summary.title)
        }
      }).catch(() => undefined)
      return true
    } catch (reason) {
      unwatchPendingCompletion(projectId, { sessionId })
      useChatSessionStore.getState().removeMessage(sessionId, optimisticId)
      setSendError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
      return false
    }
  }, [sessionId, projectId, engineConfig, permissionMode, planMode, goalMode,
    effectiveEngine, onSessionIdChange, onTitleChange, t])

  const sendPendingContent = useCallback(async (
    content: string, pendingInsertIds: string[],
  ): Promise<boolean> => {
    if (!sessionId || !projectId) return false
    if (!running) return sendMessageNow(content)
    setSendError('')
    const optimisticId = useChatSessionStore.getState().addUserMessage(sessionId, content)
    flushWsSubscriptionNow()
    const dropOptimistic = () => {
      useChatSessionStore.getState().removeMessage(sessionId, optimisticId)
    }
    try {
      const accepted = await chatSessionApi.sendLiveMessage(sessionId, projectId, content, pendingInsertIds)
      useChatSessionStore.getState().confirmUserMessage(sessionId, optimisticId, accepted.message_id, accepted.created_at)
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : ''
      if (message.includes('待插入消息已被处理')) return true
      // 上一轮在前端判忙、后端已收尾：按 409 状态兜底（文本匹配只做兼容），
      // 走普通发送开新一轮；其它错误撤掉乐观气泡。
      const turnGone = reason instanceof ApiError
        ? reason.status === 409
        : (message.includes('not running') || message.includes('未在运行'))
      if (turnGone) {
        dropOptimistic()
        return sendMessageNow(content)
      }
      dropOptimistic()
      setSendError(message || t('chatSession.sendFailed'))
      return false
    }
  }, [projectId, running, sendMessageNow, sessionId, t])

  const stop = useCallback(async () => {
    if (!sessionId || !projectId || stopping) return false
    setStopping(true)
    setSendError('')
    try {
      const result = await chatSessionApi.stop(sessionId, projectId)
      if (result.stopped) {
        useChatSessionStore.getState().markStopped(sessionId)
        return true
      } else {
        setSendError(t('chatSession.stopFailed'))
      }
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('chatSession.stopFailed'))
    } finally {
      setStopping(false)
    }
    return false
  }, [sessionId, projectId, stopping, t])

  const continueGoal = useCallback(() => sendMessageNow('/goal resume', true), [sendMessageNow])
  const endGoal = useCallback(async () => {
    if (running && !await stop()) return false
    return sendMessageNow('/goal clear', true)
  }, [running, stop, sendMessageNow])

  return { sendMessageNow, sendPendingContent, stop, continueGoal, endGoal, sendError, setSendError, stopping }
}
