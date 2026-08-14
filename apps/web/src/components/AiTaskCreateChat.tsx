import { useCallback, useEffect, useRef, useState } from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'

import {
  engineApi,
  providerApi,
  taskDraftApi,
  type CoordinatorDefaultConfig,
  type ProviderInfo,
} from '../api/client'
import { useI18n } from '../i18n'
import { useTaskDraftStore, type TaskDraftResult } from '../stores/taskDraftStore'
import { a2uiActionMessageParams } from '../utils/a2ui'
import { applyTaskQuickPrompt } from '../utils/taskQuickPrompts.js'
import { flushWsSubscriptionNow } from '../hooks/useWebSocket'
import AssistantChatPanel from './AssistantChatPanel'
import MarkdownMessage from './MarkdownMessage'


export interface AiTaskCreateChatProps {
  projectId: string
  taskTitle: string
  taskDescription: string
  workflowId?: string
  startStepKey?: string
  initialMessage?: string
  allowGenerateTitle?: boolean
  candidateWorkflowIds?: string[]
  /** 挂载后自动发送 initialMessage（headless 预览用），默认不自动发送 */
  autoSend?: boolean
  onDraft: (draft: TaskDraftResult) => void
  onBusyChange?: (busy: boolean) => void
  onClose?: () => void
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `task-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function AiTaskCreateChat({
  projectId,
  taskTitle,
  taskDescription,
  workflowId,
  startStepKey,
  initialMessage,
  allowGenerateTitle = false,
  candidateWorkflowIds,
  autoSend = false,
  onDraft,
  onBusyChange,
  onClose,
}: AiTaskCreateChatProps) {
  const { t, locale } = useI18n()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState(initialMessage || '')
  const [sendError, setSendError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorDefaultConfig | null>(null)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [selectedEngine, setSelectedEngine] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedFastModel, setSelectedFastModel] = useState('')
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const deliveredResultRef = useRef<Record<string, unknown> | undefined>(undefined)
  const sessionIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  const session = useTaskDraftStore((state) => (
    sessionId ? state.sessions[sessionId] : undefined
  ))
  const running = session?.running ?? false
  const messages = session?.messages ?? []
  const latestResult = session?.latestResult
  const autoSentRef = useRef(false)

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { runningRef.current = running }, [running])

  useEffect(() => {
    onBusyChange?.(running)
    if (!running) setStopping(false)
  }, [onBusyChange, running])

  useEffect(() => {
    if (!latestResult || latestResult === deliveredResultRef.current) return
    deliveredResultRef.current = latestResult
    onDraft(latestResult as TaskDraftResult)
  }, [latestResult, onDraft])

  useEffect(() => {
    let active = true
    engineApi.coordinatorDefaults()
      .then((config) => {
        if (!active) return
        setCoordinatorConfig(config)
        setCoordinatorConfigError('')
      })
      .catch((reason) => {
        if (!active) return
        setCoordinatorConfigError(
          reason instanceof Error ? reason.message : t('taskList.aiConfigLoadFailed'),
        )
      })
    return () => { active = false }
  }, [t])

  useEffect(() => {
    let active = true
    providerApi.list()
      .then((result) => {
        if (active) setProviders(result.providers.filter((item) => item.enabled))
      })
      .catch(() => { /* provider list is optional for the engine picker */ })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (initialMessage) setInput(initialMessage)
  }, [initialMessage])

  useEffect(() => () => {
    const activeSessionId = sessionIdRef.current
    if (!activeSessionId) return
    if (runningRef.current) void taskDraftApi.stop(activeSessionId, projectId).catch(() => undefined)
    useTaskDraftStore.getState().resetSession(activeSessionId)
  }, [projectId])

  const send = useCallback(async (override?: string) => {
    const content = (override ?? input).trim()
    if (!content || running) return
    setSendError('')
    let sid = sessionId
    if (!sid) {
      sid = randomId()
      useTaskDraftStore.getState().newSession(sid)
      setSessionId(sid)
    }
    useTaskDraftStore.getState().addUserMessage(sid, content)
    setInput('')
    // 先让服务端订阅到该会话，再发起引擎调用，避免首条事件被过滤丢弃。
    flushWsSubscriptionNow()
    try {
      const accepted = await taskDraftApi.chat(projectId, content, sid, randomId(), {
        title: taskTitle,
        description: taskDescription,
        workflowId,
        startStepKey,
        engine: selectedEngine || undefined,
        providerId: selectedProvider || undefined,
        model: selectedModel || undefined,
        fastModel: selectedFastModel || undefined,
        thinkingEffort: selectedThinkingEffort || undefined,
        allowGenerateTitle,
        candidateWorkflowIds,
      })
      if (accepted.session_id && accepted.session_id !== sid) {
        const oldSession = useTaskDraftStore.getState().sessions[sid]
        if (oldSession) {
          useTaskDraftStore.getState().newSession(accepted.session_id)
          useTaskDraftStore.setState((state) => ({
            sessions: { ...state.sessions, [accepted.session_id]: oldSession },
          }))
          useTaskDraftStore.getState().resetSession(sid)
        }
        setSessionId(accepted.session_id)
      }
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('taskList.aiSendFailed'))
    }
  }, [allowGenerateTitle, candidateWorkflowIds, input, projectId, running, selectedEngine, selectedProvider, selectedFastModel, selectedModel, selectedThinkingEffort, sessionId, startStepKey, t, taskDescription, taskTitle, workflowId])

  useEffect(() => {
    if (!autoSend || autoSentRef.current) return
    if (!initialMessage?.trim()) return
    autoSentRef.current = true
    void send(initialMessage)
  }, [autoSend, initialMessage, send])

  const stop = useCallback(async () => {
    if (!sessionId || stopping) return
    setStopping(true)
    setSendError('')
    try {
      const result = await taskDraftApi.stop(sessionId, projectId)
      if (!result.stopped) {
        setSendError(t('taskList.aiStopFailed'))
      } else {
        useTaskDraftStore.getState().markStopped(sessionId)
      }
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('taskList.aiStopFailed'))
    } finally {
      setStopping(false)
    }
  }, [sessionId, stopping, projectId, t])

  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    void send(t('taskDetail.a2uiActionMessage', a2uiActionMessageParams(action)))
  }, [send, t])

  return (
    <AssistantChatPanel
      projectId={projectId}
      title={t('taskList.aiTaskAgent')}
      messages={messages}
      availableCommands={session?.availableCommands}
      running={running}
      stopping={stopping}
      input={input}
      sendError={sendError}
      locale={locale}
      attachmentPrefix="task-create"
      onInputChange={(value) => { setInput(value); setSendError('') }}
      onSend={() => void send()}
      onStop={() => void stop()}
      onAttachmentError={setSendError}
      onClose={onClose}
      onA2uiAction={handleA2uiAction}
      afterMessages={latestResult ? (
        <div style={{ marginTop: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--meta)', margin: '2px 2px 8px' }}>
            {t('taskList.aiDraftTitle')}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', padding: '9px 11px' }}>
            {typeof latestResult.title === 'string' && latestResult.title.trim() && (
              <div style={{ fontWeight: 600, fontSize: 13 }}>{latestResult.title}</div>
            )}
            <div style={{ marginTop: typeof latestResult.title === 'string' && latestResult.title.trim() ? 6 : 0, fontSize: 13, lineHeight: 1.6 }}>
              <MarkdownMessage content={String(latestResult.description || '')} projectId={projectId} />
            </div>
          </div>
        </div>
      ) : undefined}
      quickPromptsLabel={t('taskList.aiQuickPromptsLabel')}
      quickPrompts={[
        { label: t('taskList.aiQuickDescribe'), prompt: t('taskList.aiQuickDescribePrompt') },
        { label: t('taskList.aiQuickAcceptance'), prompt: t('taskList.aiQuickAcceptancePrompt') },
        { label: t('taskList.aiQuickSteps'), prompt: t('taskList.aiQuickStepsPrompt') },
        { label: t('taskList.aiQuickRisks'), prompt: t('taskList.aiQuickRisksPrompt') },
      ]}
      onQuickPromptSelect={(prompt) => {
        setInput((current) => applyTaskQuickPrompt(current, prompt))
        setSendError('')
      }}
      copy={{
        emptyIntro: t('taskList.aiEmptyIntro'),
        thinking: t('taskList.aiThinking'),
        me: t('aiFlow.me'),
        meInitials: t('aiFlow.meInitials'),
        agent: t('taskList.aiTaskAgent'),
        agentInitials: t('taskList.aiAgentInitials'),
        placeholder: t('taskList.aiPlaceholder'),
        fullPrompt: t('aiFlow.fullPrompt'),
        closePrompt: t('common.close'),
      }}
      config={{
        engines: coordinatorConfig?.available_engines || [],
        engine: selectedEngine,
        providers,
        providerId: selectedProvider,
        defaultEngine: coordinatorConfig?.engine || 'claude',
        model: selectedModel,
        fastModel: selectedFastModel,
        thinkingEffort: selectedThinkingEffort,
        disabled: !coordinatorConfig || coordinatorConfigError !== '' || running,
        error: coordinatorConfigError,
        hint: coordinatorConfig ? t('aiFlow.sessionHint') : '',
        engineTitle: t('taskList.aiEngineTitle'),
        onEngineChange: (engineId) => {
          setSelectedEngine(engineId)
          setSelectedProvider('')
          setSelectedModel('')
          setSelectedFastModel('')
          setSelectedThinkingEffort('')
        },
        onProviderChange: (providerId) => {
          setSelectedProvider(providerId)
          setSelectedModel('')
          setSelectedFastModel('')
          setSelectedThinkingEffort('')
        },
        onModelChange: setSelectedModel,
        onFastModelChange: setSelectedFastModel,
        onThinkingEffortChange: setSelectedThinkingEffort,
        onReset: () => {
          setSelectedEngine('')
          setSelectedProvider('')
          setSelectedModel('')
          setSelectedFastModel('')
          setSelectedThinkingEffort('')
        },
      }}
    />
  )
}
