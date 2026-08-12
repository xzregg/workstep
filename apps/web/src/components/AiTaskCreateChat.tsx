import { useCallback, useEffect, useRef, useState } from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'

import { engineApi, taskDraftApi, type CoordinatorDefaultConfig } from '../api/client'
import { useI18n } from '../i18n'
import { useTaskDraftStore, type TaskDraftResult } from '../stores/taskDraftStore'
import { a2uiActionMessageParams } from '../utils/a2ui'
import { applyTaskQuickPrompt } from '../utils/taskQuickPrompts.js'
import AssistantChatPanel from './AssistantChatPanel'


export interface AiTaskCreateChatProps {
  projectId: string
  taskTitle: string
  taskDescription: string
  workflowId?: string
  startStepKey?: string
  initialMessage?: string
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
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedFastModel, setSelectedFastModel] = useState('')
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState('')
  const deliveredResultRef = useRef<Record<string, unknown> | undefined>(undefined)
  const sessionIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  const session = useTaskDraftStore((state) => (
    sessionId ? state.sessions[sessionId] : undefined
  ))
  const running = session?.running ?? false
  const messages = session?.messages ?? []
  const latestResult = session?.latestResult

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
    if (initialMessage) setInput(initialMessage)
  }, [initialMessage])

  useEffect(() => () => {
    const activeSessionId = sessionIdRef.current
    if (!activeSessionId) return
    if (runningRef.current) void taskDraftApi.stop(activeSessionId).catch(() => undefined)
    useTaskDraftStore.getState().resetSession(activeSessionId)
  }, [])

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
    try {
      const accepted = await taskDraftApi.chat(projectId, content, sid, randomId(), {
        title: taskTitle,
        description: taskDescription,
        workflowId,
        startStepKey,
        engine: selectedEngine || undefined,
        model: selectedModel || undefined,
        fastModel: selectedFastModel || undefined,
        thinkingEffort: selectedThinkingEffort || undefined,
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
  }, [input, projectId, running, selectedEngine, selectedFastModel, selectedModel, selectedThinkingEffort, sessionId, startStepKey, t, taskDescription, taskTitle, workflowId])

  const stop = useCallback(async () => {
    if (!sessionId || stopping) return
    setStopping(true)
    setSendError('')
    try {
      const result = await taskDraftApi.stop(sessionId)
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
  }, [sessionId, stopping, t])

  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    void send(t('taskDetail.a2uiActionMessage', a2uiActionMessageParams(action)))
  }, [send, t])

  return (
    <AssistantChatPanel
      projectId={projectId}
      title={t('taskList.aiTaskAgent')}
      messages={messages}
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
        tag: t('taskList.aiTag'),
        userTagTitle: t('taskList.aiUserTagTitle'),
        placeholder: t('taskList.aiPlaceholder'),
        fullPrompt: t('aiFlow.fullPrompt'),
        closePrompt: t('common.close'),
      }}
      config={{
        engines: coordinatorConfig?.available_engines || [],
        engine: selectedEngine,
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
          setSelectedModel('')
          setSelectedFastModel('')
          setSelectedThinkingEffort('')
        },
        onModelChange: setSelectedModel,
        onFastModelChange: setSelectedFastModel,
        onThinkingEffortChange: setSelectedThinkingEffort,
        onReset: () => {
          setSelectedEngine('')
          setSelectedModel('')
          setSelectedFastModel('')
          setSelectedThinkingEffort('')
        },
      }}
    />
  )
}
