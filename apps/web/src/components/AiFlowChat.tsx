import { useCallback, useEffect, useRef, useState } from 'react'
import ChatMessageBubble from './ChatMessageBubble'
import ChatInput from './ChatInput'
import MessageMetaBar from './MessageMetaBar'
import MessageResponseFooter from './MessageResponseFooter'
import MarkdownMessage from './MarkdownMessage'
import {
  workflowGenApi,
  engineApi,
  type CoordinatorDefaultConfig,
} from '../api/client'
import { useWorkflowGenStore, type GenProposalCard } from '../stores/workflowGenStore'
import { formatConversationDateTime } from '../utils/datetime'

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
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export default function AiFlowChat({
  projectId,
  onProposal,
  onBusyChange,
  title = 'AI 流程助手',
  onClose,
}: AiFlowChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sendError, setSendError] = useState('')
  const [appliedCardId, setAppliedCardId] = useState<string | null>(null)
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  // Coordinator engine / model overrides (session-scoped: this chat turn only).
  const [coordinatorConfig, setCoordinatorConfig] = useState<CoordinatorDefaultConfig | null>(null)
  const [coordinatorConfigError, setCoordinatorConfigError] = useState('')
  const [selectedEngine, setSelectedEngine] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedFastModel, setSelectedFastModel] = useState('')
  const session = useWorkflowGenStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const running = session?.running ?? false
  const messages = session?.messages ?? []
  const latestProposals = session?.latestProposals ?? []
  const rejectionMessage = session?.rejectionMessage
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onBusyChange?.(running)
  }, [running, onBusyChange])

  // A fresh proposals batch resets the "applied" highlight.
  useEffect(() => {
    setAppliedCardId(null)
  }, [latestProposals])

  // Ensure freshly arrived proposal cards are visible.
  useEffect(() => {
    if (latestProposals.length > 0) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [latestProposals])

  const applyCard = (card: GenProposalCard) => {
    setAppliedCardId(card.id)
    onProposal?.(card.steps)
  }

  // Auto-scroll to the latest message.
  const lastContent = messages.length > 0 ? messages[messages.length - 1].content : ''
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, lastContent])

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
        setCoordinatorConfigError(reason instanceof Error ? reason.message : '协调引擎配置加载失败')
      })
    return () => { active = false }
  }, [])

  const send = useCallback(async () => {
    const content = input.trim()
    if (!content || running) return
    setSendError('')
    let sid = sessionId
    if (!sid) {
      sid = randomId()
      useWorkflowGenStore.getState().newSession(sid)
      setSessionId(sid)
    }
    useWorkflowGenStore.getState().addUserMessage(sid, content)
    setInput('')
    try {
      const accepted = await workflowGenApi.chat(projectId, content, sid, randomId(), {
        engine: selectedEngine || undefined,
        model: selectedModel || undefined,
        fastModel: selectedFastModel || undefined,
      })
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
      setSendError(reason instanceof Error ? reason.message : '发送失败，请重试')
    }
  }, [input, running, sessionId, projectId, selectedEngine, selectedModel, selectedFastModel])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)',
      }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13 }}>{title}</span>
        {running && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--meta)' }}>
            <span className="task-status-spinner" aria-hidden="true" /> 协调 Agent 思考中…
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onClose && (
          <button className="btn-icon" aria-label="关闭" onClick={onClose}>✕</button>
        )}
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--meta)', padding: '4px 2px', lineHeight: 1.6 }}>
            描述你的目标（例如“做一个内容发布流程”），我会先追问几个关键问题，然后为你生成可直接编辑的流程编排。
          </div>
        )}
        {messages.map((m) => (
          <ChatMessageBubble
            key={m.id}
            role={m.role}
            sender={m.role === 'user' ? '我' : '协调 Agent'}
            initials={m.role === 'user' ? '我' : '协'}
            color={m.role === 'user' ? 'var(--accent)' : '#7c3aed'}
            content={m.content}
            streaming={m.status === 'running'}
            projectId={projectId}
            error={m.role === 'assistant' ? m.error : undefined}
            showLoading={m.role === 'assistant' && m.status === 'running'}
            loading={m.role === 'assistant'
              ? <div className="engine-loading-message" role="status">协调 Agent 思考中…</div>
              : undefined}
            header={m.role === 'user' ? (
              <>
                {formatConversationDateTime(m.created_at)}
                <span
                  title="发给 AI 流程助手（协调引擎生成模式）"
                  style={{
                    padding: '1px 6px', borderRadius: 999, fontSize: 10,
                    border: '1px solid var(--border-soft)',
                    background: 'rgba(124,58,237,0.08)',
                    color: '#7c3aed',
                  }}
                >
                  AI 助手
                </span>
              </>
            ) : (
              <MessageMetaBar
                createdAt={m.created_at}
                running={m.status === 'running'}
                prompt={m.prompt}
                onViewPrompt={setViewingPrompt}
              />
            )}
            footer={m.role === 'assistant' && m.status !== 'running' ? (
              <MessageResponseFooter
                content={m.content}
                engine={m.engine}
                model={m.model}
              />
            ) : undefined}
          />
        ))}
        {latestProposals.length > 0 && (
          <div style={{ marginTop: 2 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--meta)', margin: '2px 2px 8px' }}>
              选择流程方案
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {latestProposals.map((card) => {
                const applied = appliedCardId === card.id
                return (
                  <button
                    key={card.id}
                    onClick={() => applyCard(card)}
                    disabled={applied}
                    title="应用到画布预览"
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
                      <span style={{ fontSize: 11, color: 'var(--meta)' }}>{card.nodeCount} 步</span>
                      <span style={{ flex: 1 }} />
                      <span style={{ fontSize: 11, color: applied ? 'var(--success)' : 'var(--accent)' }}>
                        {applied ? '✓ 已应用' : '应用'}
                      </span>
                    </div>
                    {card.summary && (
                      <div style={{ fontSize: 12, color: 'var(--meta)', marginTop: 3, lineHeight: 1.5 }}>
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
            marginTop: 2, padding: '7px 10px', borderRadius: 8, fontSize: 12,
            color: 'var(--danger)',
            background: 'color-mix(in oklab, var(--danger), transparent 94%)',
            border: '1px solid color-mix(in oklab, var(--danger), transparent 75%)',
            lineHeight: 1.5,
          }}>
            {rejectionMessage}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {sendError && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--danger)' }}>{sendError}</div>
      )}

      <div style={{
        flexShrink: 0, padding: '10px 12px',
        borderTop: '1px solid var(--border-soft)', background: 'var(--bg)',
      }}>
        <ChatInput
          value={input}
          onChange={(value) => { setInput(value); setSendError('') }}
          onSend={() => void send()}
          disabled={running}
          running={running}
          placeholder="描述目标，或继续调整流程（支持粘贴图片，Enter 发送，Shift+Enter 换行）"
          imageAttach={{
            projectId,
            prefix: 'flow-gen',
            onError: (message) => setSendError(message),
          }}
          config={{
            engines: coordinatorConfig?.available_engines || [],
            engine: selectedEngine,
            defaultEngine: coordinatorConfig?.engine || 'claude',
            model: selectedModel,
            fastModel: selectedFastModel,
            disabled: !coordinatorConfig || coordinatorConfigError !== '' || running,
            error: coordinatorConfigError,
            hint: coordinatorConfig ? '仅本次生成会话生效' : '',
            engineTitle: '本次流程生成会话使用的协调引擎；不修改全局任务协调配置',
            onEngineChange: (engineId) => {
              setSelectedEngine(engineId)
              setSelectedModel('')
              setSelectedFastModel('')
            },
            onModelChange: setSelectedModel,
            onFastModelChange: setSelectedFastModel,
            onReset: () => {
              setSelectedEngine('')
              setSelectedModel('')
              setSelectedFastModel('')
            },
          }}
        />
      </div>

      {viewingPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="完整提示词"
          style={{
            position: 'fixed', inset: 0, zIndex: 1450,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
          onClick={() => setViewingPrompt(null)}
        >
          <div
            style={{
              width: 'min(860px, 92vw)', maxHeight: '84vh',
              background: 'var(--bg)', borderRadius: 12,
              boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <strong style={{ flex: 1, fontSize: 15 }}>完整提示词</strong>
              <button type="button" className="btn-icon" aria-label="关闭提示词" onClick={() => setViewingPrompt(null)}>✕</button>
            </div>
            <div style={{ padding: 18, overflow: 'auto', fontSize: 12, lineHeight: 1.65 }}>
              <MarkdownMessage content={viewingPrompt} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
