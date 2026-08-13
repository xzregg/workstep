import { useCallback, useEffect, useRef, useState } from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import AssistantChatPanel from './AssistantChatPanel'
import {
  a2uiActionMessageParams,
  pendingAutoApplyProposal,
  resolveA2uiFlowSteps,
  shouldShowA2uiProposalCards,
} from '../utils/a2ui'
import {
  workflowGenApi,
  engineApi,
  providerApi,
  type CoordinatorDefaultConfig,
  type ProviderInfo,
} from '../api/client'
import { useWorkflowGenStore, type GenProposalCard } from '../stores/workflowGenStore'
import { useI18n } from '../i18n'
import { selectWorkflowTurnContext } from '../utils/workflowContext'
import { applyAssistantQuickPrompt } from '../utils/taskQuickPrompts.js'

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
  onProposal?: (steps: any) => void
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

/** Stable conversation id for a workflow edit session (mirrors backend key). */
function workflowSessionId(projectId: string, workflowId: string): string {
  return `wf:${projectId}:${workflowId}`
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const EMPTY_PROPOSALS: GenProposalCard[] = []

export default function AiFlowChat({
  projectId,
  onProposal,
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
  // Coordinator engine / model overrides (session-scoped: this chat turn only).
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorDefaultConfig | null>(null)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [selectedEngine, setSelectedEngine] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedFastModel, setSelectedFastModel] = useState('')
  const [selectedThinkingEffort, setSelectedThinkingEffort] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const session = useWorkflowGenStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const running = session?.running ?? false
  const messages = session?.messages ?? []
  const latestProposals = session?.latestProposals ?? EMPTY_PROPOSALS
  const rejectionMessage = session?.rejectionMessage
  const lastCanvasSnapshotRef = useRef<string | null>(null)

  useEffect(() => {
    onBusyChange?.(running)
    if (!running) setStopping(false)
  }, [running, onBusyChange])

  // A fresh proposals batch resets the "applied" highlight.
  useEffect(() => {
    setAppliedCardId(null)
  }, [latestProposals])

  useEffect(() => {
    const proposal = pendingAutoApplyProposal(latestProposals, appliedCardId)
    if (!proposal) return
    setAppliedCardId(proposal.id)
    onProposal?.(proposal.steps)
  }, [appliedCardId, latestProposals, onProposal])

  const applyCard = (card: GenProposalCard) => {
    setAppliedCardId(card.id)
    onProposal?.(card.steps)
  }

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
        setCoordinatorConfigError(reason instanceof Error ? reason.message : t('aiFlow.configLoadFailed'))
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

  // Workflow edit sessions reuse a stable conversation: load prior history.
  useEffect(() => {
    lastCanvasSnapshotRef.current = null
    if (!workflowId || !projectId) return
    const canonicalId = workflowSessionId(projectId, workflowId)
    setSessionId(canonicalId)
    useWorkflowGenStore.getState().newSession(canonicalId)
    let active = true
    workflowGenApi.history(projectId, workflowId)
      .then((history) => {
        if (!active) return
        const store = useWorkflowGenStore.getState()
        store.newSession(history.session_id)
        store.hydrateSession(
          history.session_id,
          (history.messages || []).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            status: m.status,
            engine: m.engine,
            model: m.model,
            created_at: m.created_at,
            ended_at: m.ended_at,
            prompt: m.prompt,
            events: (m.events || []).map((e) => ({
              ...e,
              type: e.type || '',
              data: e.data || {},
            })),
          })),
        )
        if (history.session_id !== canonicalId) setSessionId(history.session_id)
      })
      .catch(() => { /* keep the empty session; next turn still works */ })
    return () => { active = false }
  }, [workflowId, projectId])

  const send = useCallback(async (contentOverride?: string) => {
    const content = (contentOverride ?? input).trim()
    if (!content || running) return
    setSendError('')
    let sid = sessionId
    if (!sid) {
      sid = workflowId && projectId
        ? workflowSessionId(projectId, workflowId)
        : randomId()
      useWorkflowGenStore.getState().newSession(sid)
      setSessionId(sid)
    }
    useWorkflowGenStore.getState().addUserMessage(sid, content)
    setInput('')
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
      const accepted = await workflowGenApi.chat(projectId, content, sid, randomId(), {
        engine: selectedEngine || undefined,
        providerId: selectedProvider || undefined,
        model: selectedModel || undefined,
        fastModel: selectedFastModel || undefined,
        thinkingEffort: selectedThinkingEffort || undefined,
        steps: turnContext.steps,
        workflowName: 'workflowName' in turnContext ? turnContext.workflowName : undefined,
        contextMode: turnContext.mode,
        workflowId: workflowId || undefined,
      })
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
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('aiFlow.sendFailed'))
    }
  }, [input, running, sessionId, projectId, selectedEngine, selectedProvider, selectedModel, selectedFastModel, selectedThinkingEffort, getCanvasSteps, workflowId, workflowName, t])

  const handleA2uiAction = useCallback((action: A2uiClientAction) => {
    const flow = resolveA2uiFlowSteps(action, latestProposals)
    if (flow) {
      setAppliedCardId(flow.proposalId)
      onProposal?.(flow.steps)
      return
    }
    void send(t('taskDetail.a2uiActionMessage', a2uiActionMessageParams(action)))
  }, [latestProposals, onProposal, send, t])

  const resetConversation = useCallback(async () => {
    if (!workflowId || !projectId || running || resetting) return
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
      lastCanvasSnapshotRef.current = null
      setInput('')
      setAppliedCardId(null)
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : t('aiFlow.resetFailed'))
    } finally {
      setResetting(false)
    }
  }, [projectId, resetting, running, sessionId, t, workflowId])

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
      const result = await workflowGenApi.stop(sessionId)
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
  }, [sessionId, stopping, t])

  return (
    <>
      <AssistantChatPanel
        projectId={projectId}
        title={title ?? t('aiFlow.title')}
        messages={messages}
        running={running}
        stopping={stopping}
        input={input}
        sendError={sendError}
        locale={locale}
        attachmentPrefix="flow-gen"
        scrollKey={latestProposals.length}
        onInputChange={(value) => { setInput(value); setSendError('') }}
        onSend={() => void send()}
        onStop={() => void stop()}
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
        {shouldShowA2uiProposalCards(latestProposals.length, appliedCardId) && (
          <div style={{ marginTop: 2 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--meta)', margin: '2px 2px 8px' }}>
              {t('aiFlow.chooseProposal')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {latestProposals.map((card) => {
                const applied = appliedCardId === card.id
                return (
                  <button
                    key={card.id}
                    onClick={() => applyCard(card)}
                    disabled={applied}
                    title={t('aiFlow.applyToCanvas')}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', cursor: applied ? 'default' : 'pointer',
                      border: `1px solid ${applied ? 'var(--success)' : 'var(--border)'}`,
                      borderRadius: 10, background: applied
                        ? 'color-mix(in oklab, var(--success), transparent 94%)'
                        : 'var(--surface)',
                      padding: '9px 11px', color: 'var(--fg)', fontFamily: 'var(--font-body)', fontSize: 13,
                      transition: 'border-color 0.15s, box-shadow 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{card.title}</span>
                      <span style={{ fontSize: 11, color: 'var(--meta)' }}>{t('aiFlow.stepsCount', { count: card.nodeCount })}</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 11, color: applied ? 'var(--success)' : 'var(--accent)' }}>
                        {applied ? t('aiFlow.applied') : t('aiFlow.apply')}
                      </span>
                    </div>
                    {card.summary && (
                      <div style={{ fontSize: 13, color: 'var(--meta)', marginTop: 3, lineHeight: 1.5 }}>
                        {card.summary}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {rejectionMessage && latestProposals.length === 0 && (
          <div style={{
            marginTop: 2, padding: '7px 10px', borderRadius: 8, fontSize: 13,
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
          engineTitle: t('aiFlow.engineTitle'),
          onEngineChange: (engineId) => {
            lastCanvasSnapshotRef.current = null
            setSelectedEngine(engineId)
            setSelectedProvider('')
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedThinkingEffort('')
          },
          onProviderChange: (providerId) => {
            lastCanvasSnapshotRef.current = null
            setSelectedProvider(providerId)
            setSelectedModel('')
            setSelectedFastModel('')
            setSelectedThinkingEffort('')
          },
          onModelChange: (model) => {
            lastCanvasSnapshotRef.current = null
            setSelectedModel(model)
          },
          onFastModelChange: setSelectedFastModel,
          onThinkingEffortChange: setSelectedThinkingEffort,
          onReset: () => {
            lastCanvasSnapshotRef.current = null
            setSelectedEngine('')
            setSelectedProvider('')
            setSelectedModel('')
            setSelectedFastModel('')
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
