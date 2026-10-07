import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUuid } from '../utils/uuid'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import AssistantChatPanel from './AssistantChatPanel'
import FlowStepApplyPanel from './FlowStepApplyPanel'
import {
  a2uiActionMessageParams,
  pendingAutoApplyProposal,
  resolveA2uiFlowSteps,
} from '../utils/a2ui'
import {
  assistantApi,
  workflowGenApi,
  providerApi,
  type AssistantConfigInfo,
  type ProviderInfo,
} from '../api/client'
import { useWorkflowGenStore, type GenProposalCard } from '../stores/workflowGenStore'
import {
  publishEngineCatalog,
  useCoordinatorEngines,
} from '../stores/engineAvailabilityStore'
import { useI18n } from '../i18n'
import { selectWorkflowTurnContext } from '../utils/workflowContext'
import { applyAssistantQuickPrompt } from '../utils/taskQuickPrompts.js'
import { flushWsSubscriptionNow } from '../hooks/useWebSocket'
import { useWorkflowMessageEvents } from '../hooks/useWorkflowMessageEvents'
import { useWorkflowConversationHistory, workflowSessionId } from '../hooks/useWorkflowConversationHistory'
import { usePromptEnhance } from '../hooks/usePromptEnhance'
import { cloneCanvasSteps } from '../utils/canvasRestore'
import { applyWorkflowPatch } from '../utils/workflowPatch'

/* ══════════════════════════════════════════
   AiFlowChat — reusable AI flow-design chat.

   Multi-turn conversation with the coordinator engine
   (generation mode). Live events arrive over the global
   WebSocket keyed by session_id; each validated
   flow_proposal is surfaced via onProposal(steps) so the
   parent can render/apply it to a canvas preview.
   ══════════════════════════════════════════ */

export interface AiFlowChatProps {
  projectId: string
  /** Called with the steps ({nodes, connections}) of each validated proposal. */
  onProposal?: (steps: any, proposal?: GenProposalCard) => void
  /** Restores a captured canvas directly, without proposal overwrite confirmation. */
  onRestore?: (steps: any) => void
  /** Fired when a generation turn starts/ends. */
  onBusyChange?: (busy: boolean) => void
  title?: string
  onClose?: () => void
  /** Returns the current canvas JSON so the agent adjusts the live editor content. */
  getCanvasSteps?: () => any
  /**
   * When set, the conversation is pinned to this workflow: the same session
   * (and history) is reused every time the workflow is edited. When unset,
   * each open starts a brand-new session (create mode).
   */
  workflowId?: string
  workflowName?: string
  /** Prefill the chat composer without sending. */
  initialMessage?: string
}

const EMPTY_PROPOSALS: GenProposalCard[] = []

export default function AiFlowChat({
  projectId,
  onProposal,
  onRestore,
  onBusyChange,
  title,
  onClose,
  getCanvasSteps,
  workflowId,
  workflowName = '',
  initialMessage,
}: AiFlowChatProps) {
  const { t, locale } = useI18n()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sendError, setSendError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [appliedCardId, setAppliedCardId] = useState<string | null>(null)
  /** 打开当前流程助手时的初始画布，供「还原」按钮反复恢复。 */
  const [restoreSteps, setRestoreSteps] = useState<any | null>(null)
  const {
    enhance,
    onInputChange: enhanceInputChanged,
    reset: resetEnhance,
  } = usePromptEnhance({
    projectId,
    getDraft: () => input,
    setDraft: setInput,
    onError: setSendError,
    errorMessage: t('chatSession.enhanceFailed'),
  })
  // Assistant engine / model overrides (session-scoped: this chat turn only).
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
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const session = useWorkflowGenStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const running = session?.running ?? false
  const messages = session?.messages ?? []
  const latestProposals = session?.latestProposals ?? EMPTY_PROPOSALS
  const rejectionMessage = session?.rejectionMessage
  const lastCanvasSnapshotRef = useRef<string | null>(null)
  // Patch proposals that were not auto-applied (multi-step edits, removals)
  // can be applied step-by-step through the inline picker.
  const partialApplyCards = latestProposals.filter(
    (card) => !!card.patch
      && card.autoApply !== true
      && (card.stepChanges?.length ?? 0) > 0,
  )
  const getCanvasStepsRef = useRef(getCanvasSteps)
  getCanvasStepsRef.current = getCanvasSteps

  useEffect(() => {
    const initialSteps = getCanvasStepsRef.current?.() ?? { nodes: [], connections: [] }
    setRestoreSteps(cloneCanvasSteps(initialSteps))
  }, [projectId, workflowId])

  useEffect(() => {
    onBusyChange?.(running)
    if (!running) setStopping(false)
  }, [running, onBusyChange])

  // A fresh proposals batch resets the "applied" highlight.
  useEffect(() => {
    setAppliedCardId(null)
  }, [latestProposals])

  const applyFlowSteps = useCallback((
    steps: any,
    proposalId: string,
    mergePatch = true,
  ) => {
    // 仅当按钮载荷携带 proposalId 时才更新“已应用”标记：历史按钮没有该字段，
    // 置空会让 autoApply effect 把最近一轮自动方案重新应用，覆盖用户刚选的方案。
    if (proposalId) setAppliedCardId(proposalId)
    const proposal = latestProposals.find((item) => item.id === proposalId)
    const currentSteps = getCanvasStepsRef.current?.() ?? { nodes: [], connections: [] }
    const resolvedSteps = mergePatch && proposal?.patch
      ? applyWorkflowPatch(currentSteps, proposal.patch, null)
      : steps
    onProposal?.(resolvedSteps, proposal)
  }, [latestProposals, onProposal])

  useEffect(() => {
    const proposal = pendingAutoApplyProposal(latestProposals, appliedCardId)
    if (!proposal) return
    applyFlowSteps(proposal.steps, proposal.id ?? '')
  }, [appliedCardId, latestProposals, applyFlowSteps])

  const handleRestore = useCallback(() => {
    if (restoreSteps === null) return
    onRestore?.(cloneCanvasSteps(restoreSteps))
  }, [restoreSteps, onRestore])

  useEffect(() => {
    let active = true
    assistantApi.list()
      .then(({ assistants }) => {
        if (!active) return
        const config = assistants.find((item) => item.name === 'workflow_gen')
        if (!config) throw new Error(t('aiFlow.configLoadFailed'))
        setAssistantConfig(config)
        publishEngineCatalog(config.available_engines)
        setSelectedEngine(config.configured.engine || '')
        setSelectedProvider(config.configured.provider_id || '')
        setSelectedModel(config.configured.model || '')
        setSelectedFastModel(config.configured.fast_model || '')
        setSelectedVisionModel(config.configured.vision_model || '')
        setSelectedThinkingEffort(config.configured.thinking_effort || '')
        setCoordinatorConfigError('')
      })
      .catch((reason) => {
        if (!active) return
        setCoordinatorConfigError(reason instanceof Error ? reason.message : t('aiFlow.configLoadFailed'))
      })
    return () => { active = false }
  }, [projectId, t])

  useEffect(() => {
    let active = true
    providerApi.list(projectId)
      .then((result) => {
        if (active) setProviders(result.providers.filter((item) => item.enabled))
      })
      .catch(() => { /* provider list is optional for the engine picker */ })
    return () => { active = false }
  }, [projectId])

  useWorkflowConversationHistory(projectId, workflowId, setSessionId)

  useEffect(() => {
    lastCanvasSnapshotRef.current = null
  }, [workflowId, projectId])

  const loadMessageEvents = useWorkflowMessageEvents(projectId, workflowId, sessionId)

  const send = useCallback(async (contentOverride?: string) => {
    const content = (contentOverride ?? input).trim()
    if (!content || (running && contentOverride === undefined)) return false
    setSendError('')
    let sid = sessionId
    if (!sid) {
      sid = workflowId ? workflowSessionId(projectId, workflowId) : randomUuid()
      useWorkflowGenStore.getState().newSession(sid)
      setSessionId(sid)
    }
    const optimisticId = useWorkflowGenStore.getState().addUserMessage(sid, content)
    setInput('')
    resetEnhance()
    // 先让服务端订阅到该会话，再发起引擎调用，避免首条事件被过滤丢弃。
    flushWsSubscriptionNow()
    const currentSteps = getCanvasSteps?.() ?? { nodes: [], connections: [] }
    const turnContext = workflowId
      ? selectWorkflowTurnContext(
          workflowName,
          currentSteps,
          lastCanvasSnapshotRef.current,
        )
      : {
          mode: 'canvas_updated' as const,
          steps: currentSteps,
          snapshot: JSON.stringify(currentSteps),
        }
    try {
      const accepted = await workflowGenApi.chat(projectId, content, sid, randomUuid(), {
        engine: selectedEngine || undefined,
        providerId: selectedProvider || undefined,
        model: selectedModel || undefined,
        fastModel: selectedFastModel || undefined,
        visionModel: selectedVisionModel || undefined,
        thinkingEffort: selectedThinkingEffort || undefined,
        steps: turnContext.steps,
        workflowName: 'workflowName' in turnContext ? turnContext.workflowName : workflowName,
        contextMode: turnContext.mode,
        workflowId: workflowId || undefined,
      })
      useWorkflowGenStore.getState().confirmUserMessage(sid, optimisticId, accepted.turn_id)
      lastCanvasSnapshotRef.current = turnContext.snapshot
      if (accepted.session_id && accepted.session_id !== sid) {
        // Backend re-created the session; move the local state over.
        const store = useWorkflowGenStore.getState()
        const oldSession = store.sessions[sid]
        if (oldSession) {
          store.newSession(accepted.session_id)
          useWorkflowGenStore.setState((s) => ({
            sessions: {
              ...s.sessions,
              [accepted.session_id]: oldSession,
            },
          }))
          store.resetSession(sid)
        }
        setSessionId(accepted.session_id)
      }
      useWorkflowGenStore.getState().acceptAssistantReply(accepted.session_id || sid, accepted.assistant_message_id, {
        engine: selectedEngine || assistantConfig?.configured.engine,
        model: selectedModel || assistantConfig?.configured.model,
        status: accepted.status,
      })
      return true
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('aiFlow.sendFailed'))
      return false
    }
  }, [input, running, sessionId, projectId, selectedEngine, selectedProvider, selectedModel, selectedFastModel, selectedVisionModel, selectedThinkingEffort, getCanvasSteps, workflowId, workflowName, t, resetEnhance, assistantConfig])

  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    const flow = resolveA2uiFlowSteps(action, latestProposals)
    if (flow) {
      applyFlowSteps(flow.steps, flow.proposalId)
      return
    }
    void send(t('taskDetail.a2uiActionMessage', a2uiActionMessageParams(action)))
  }, [latestProposals, applyFlowSteps, send, t])

  const resetConversation = useCallback(async () => {
    if (!workflowId || running || resetting) return
    setResetConfirmOpen(false)
    setResetting(true)
    setSendError('')
    try {
      const result = await workflowGenApi.reset(projectId, workflowId)
      const canonicalId = result.session_id || workflowSessionId(projectId, workflowId)
      const store = useWorkflowGenStore.getState()
      if (sessionId) store.resetSession(sessionId)
      if (canonicalId !== sessionId) store.resetSession(canonicalId)
      store.newSession(canonicalId)
      setSessionId(canonicalId)
      const configured = assistantConfig?.configured
      setSelectedEngine(configured?.engine || '')
      setSelectedProvider(configured?.provider_id || '')
      setSelectedModel(configured?.model || '')
      setSelectedFastModel(configured?.fast_model || '')
      setSelectedVisionModel(configured?.vision_model || '')
      setSelectedThinkingEffort(configured?.thinking_effort || '')
      lastCanvasSnapshotRef.current = null
      setInput('')
      resetEnhance()
      setAppliedCardId(null)
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('aiFlow.resetFailed'))
    } finally {
      setResetting(false)
    }
  }, [assistantConfig, projectId, resetting, running, sessionId, t, workflowId, resetEnhance])

  // The add-workflow entry point only prepares a draft; the user sends it.
  useEffect(() => {
    if (!initialMessage) return
    setInput(initialMessage)
  }, [initialMessage])

  const stop = useCallback(async () => {
    if (!sessionId || stopping) return
    setStopping(true)
    setSendError('')
    try {
      const result = await workflowGenApi.stop(sessionId, projectId)
      if (!result.stopped) {
        setStopping(false)
        setSendError(t('aiFlow.stopFailed'))
      } else {
        useWorkflowGenStore.getState().markStopped(sessionId)
        setStopping(false)
      }
    } catch (reason) {
      setStopping(false)
      setSendError(reason instanceof Error ? reason.message : t('aiFlow.stopFailed'))
    }
  }, [sessionId, stopping, projectId, t])

  return (
    <>
      <AssistantChatPanel
        onLoadMessageEvents={loadMessageEvents}
        projectId={projectId}
        title={title ?? t('aiFlow.title')}
        messages={messages}
        availableCommands={session?.availableCommands}
        running={running}
        stopping={stopping}
        input={input}
        sendError={sendError}
        locale={locale}
        attachmentPrefix="flow-gen"
        scrollKey={latestProposals.length}
        onInputChange={(value) => { enhanceInputChanged(value); setInput(value); setSendError('') }}
        onSend={() => void send()}
        onSendContent={(content) => send(content)}
        onStop={() => void stop()}
        enhance={enhance}
        onAttachmentError={setSendError}
        onClose={onClose}
        onA2uiAction={handleA2uiAction}
        quickPromptsLabel={t('aiFlow.quickPromptsLabel')}
        a2uiMessages={session?.a2uiMessages}
        quickPrompts={[
          { label: t('aiFlow.quickGenerate'), prompt: t('aiFlow.quickGeneratePrompt') },
          { label: t('aiFlow.quickOptimize'), prompt: t('aiFlow.quickOptimizePrompt') },
          { label: t('aiFlow.quickReview'), prompt: t('aiFlow.quickReviewPrompt') },
          { label: t('aiFlow.quickSimplify'), prompt: t('aiFlow.quickSimplifyPrompt') },
        ]}
        onQuickPromptSelect={(prompt) => {
          setInput((current) => applyAssistantQuickPrompt(current, prompt))
          setSendError('')
        }}
        copy={{
          emptyIntro: t('aiFlow.emptyIntro'),
          thinking: t('aiFlow.thinking'),
          me: t('aiFlow.me'),
          meInitials: t('aiFlow.meInitials'),
          agent: t('aiFlow.agent'),
          agentInitials: t('aiFlow.agentInitials'),
          placeholder: t('aiFlow.placeholder'),
          fullPrompt: t('aiFlow.fullPrompt'),
          closePrompt: t('aiFlow.closePrompt'),
        }}
        composerActions={<Button
          variant="ghost"
          size="sm"
          disabled={running || restoreSteps === null}
          title={t('aiFlow.restoreStepsHint')}
          onClick={handleRestore}
          style={{ flexShrink: 0, borderRadius: 999, whiteSpace: 'nowrap' }}
        >
          {t('aiFlow.restoreSteps')}
        </Button>}
        headerActions={workflowId ? (
          <Button
            variant="ghost"
            size="sm"
            loading={resetting}
            disabled={running}
            title={t('aiFlow.resetSessionHint')}
            onClick={() => setResetConfirmOpen(true)}
          >
            {t('aiFlow.resetSession')}
          </Button>
        ) : undefined}
        afterMessages={<>
        {partialApplyCards.length > 0 && (
          <FlowStepApplyPanel
            cards={partialApplyCards}
            currentSteps={() => getCanvasStepsRef.current?.() ?? { nodes: [], connections: [] }}
            onApply={(steps, card) => applyFlowSteps(steps, card.id, false)}
            appliedCardId={appliedCardId}
            disabled={running}
          />
        )}
        {rejectionMessage && latestProposals.length === 0 && (
          <div style={{
            marginTop: 2, padding: '7px 10px', borderRadius: 8, fontSize: 'calc(13px * var(--font-scale))',
            color: 'var(--danger)',
            background: 'color-mix(in oklab, var(--danger), transparent 94%)',
            border: '1px solid color-mix(in oklab, var(--danger), transparent 75%)',
            lineHeight: 1.5,
          }}>
            {rejectionMessage}
          </div>
        )}
        </>}
        config={{
          projectId,
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
          hint: assistantConfig ? t('aiFlow.sessionHint') : '',
          engineTitle: t('aiFlow.engineTitle'),
          onEngineChange: (engineId) => {
            lastCanvasSnapshotRef.current = null
            setSelectedEngine(engineId)
            setSelectedProvider('')
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedVisionModel('')
            setSelectedThinkingEffort('')
          },
          onProviderChange: (providerId) => {
            lastCanvasSnapshotRef.current = null
            setSelectedProvider(providerId)
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedVisionModel('')
            setSelectedThinkingEffort('')
          },
          onModelChange: (model) => {
            lastCanvasSnapshotRef.current = null
            setSelectedModel(model)
          },
          onFastModelChange: setSelectedFastModel,
          onVisionModelChange: setSelectedVisionModel,
          onThinkingEffortChange: setSelectedThinkingEffort,
          onReset: () => {
            lastCanvasSnapshotRef.current = null
            setSelectedEngine('')
            setSelectedProvider('')
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedVisionModel('')
            setSelectedThinkingEffort('')
          },
        }}
      />

      <ConfirmDialog
        open={resetConfirmOpen}
        title={t('aiFlow.resetSessionTitle')}
        message={t('aiFlow.resetSessionMessage')}
        confirmText={t('aiFlow.resetSessionConfirm')}
        danger
        onConfirm={() => void resetConversation()}
        onCancel={() => setResetConfirmOpen(false)}
      />

    </>
  )
}
