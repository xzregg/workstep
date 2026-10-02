import { useCallback, useEffect, useState } from 'react'
import { chatSessionApi } from '../api/client'
import { useI18n } from '../i18n'
import { useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import type { ChatEngineConfigState } from '../utils/chatEngineConfig'
import { randomUuid } from '../utils/uuid'

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

  const sendMessageNow = useCallback(async (content: string): Promise<boolean> => {
    if (!content || !sessionId) {
      if (!sessionId) setSendError(t('chatSession.noSession'))
      return false
    }
    if (!projectId) return false
    setSendError('')
    try {
      useChatSessionStore.getState().addUserMessage(sessionId, content)
      const accepted = await chatSessionApi.chat(sessionId, projectId, content, randomUuid(), {
        engine: engineConfig.engine || undefined,
        provider_id: engineConfig.providerId || undefined,
        model: engineConfig.model || undefined,
        fast_model: engineConfig.fastModel || undefined,
        vision_model: engineConfig.visionModel || undefined,
        thinking_effort: engineConfig.thinkingEffort || undefined,
        permission_mode: permissionMode || undefined,
        plan_mode: planMode || undefined,
        goal_mode: goalMode && effectiveEngine === 'codex_sdk' || undefined,
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
      const { sessions } = await chatSessionApi.list(projectId)
      const summary = sessions.find((item) => item.id === finalSessionId)
      if (summary?.title) {
        onTitleChange(summary.title)
        useChatListStore.getState().renameSession(finalSessionId, summary.title)
      }
      return true
    } catch (reason) {
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
    try {
      useChatSessionStore.getState().addUserMessage(sessionId, content)
      await chatSessionApi.sendLiveMessage(sessionId, projectId, content, pendingInsertIds)
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
  }, [projectId, running, sendMessageNow, sessionId, t])

  const stop = useCallback(async () => {
    if (!sessionId || !projectId || stopping) return
    setStopping(true)
    setSendError('')
    try {
      const result = await chatSessionApi.stop(sessionId, projectId)
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
  }, [sessionId, projectId, stopping, t])

  return { sendMessageNow, sendPendingContent, stop, sendError, setSendError, stopping }
}
