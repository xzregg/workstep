import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'

import type { AssistantChatMessage } from '../stores/assistantStore'
import { taskApi, type EngineInputItem } from '../api/client'
import { stripA2uiBlocks } from '../utils/a2ui'
import { formatConversationDateTime } from '../utils/datetime'
import { isNearConversationBottom, conversationBottomScrollTop } from '../pages/taskDetailChat'
import Button from './Button'
import ChatInput, {
  type ChatContextUsage,
  type ChatInputEnhance,
  type ChatInputEngineConfig,
  type ChatInputPermission,
  type ChatInputPlan,
} from './ChatInput'
import ChatMessageBubble from './ChatMessageBubble'
import MarkdownMessage from './MarkdownMessage'
import MessageMetaBar from './MessageMetaBar'
import MessageResponseFooter, { usageFromEvents } from './MessageResponseFooter'
import { useUserSettingsStore } from '../stores/userSettingsStore'

export interface AssistantChatCopy {
  emptyIntro: string
  thinking: string
  me: string
  meInitials: string
  agent: string
  agentInitials: string
  tag?: string
  userTagTitle?: string
  placeholder: string
  fullPrompt: string
  closePrompt: string
}

export interface AssistantQuickPrompt {
  label: string
  prompt: string
}

export interface AssistantChatPanelProps {
  projectId: string
  title: string
  messages: AssistantChatMessage[]
  running: boolean
  stopping: boolean
  input: string
  sendError?: string
  copy: AssistantChatCopy
  locale: string
  config: ChatInputEngineConfig
  permission?: ChatInputPermission
  enhance?: ChatInputEnhance
  context?: ChatContextUsage | null
  plan?: ChatInputPlan
  availableCommands?: EngineInputItem[]
  attachmentPrefix: string
  onInputChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onAttachmentError?: (message: string) => void
  onClose?: () => void
  onA2uiAction?: (action: A2uiClientAction) => void
  headerActions?: ReactNode
  afterMessages?: ReactNode
  scrollKey?: string | number
  quickPrompts?: AssistantQuickPrompt[]
  quickPromptsLabel?: string
  onQuickPromptSelect?: (prompt: string) => void
  /** Store 累积的 A2UI 载荷（messageId → payload[]），随消息渲染。 */
  a2uiMessages?: Record<string, Record<string, unknown>[]>
  /** 用户消息上方是否显示身份标签（默认隐藏；仅任务详情对话与分享页显示）。 */
  showUserTag?: boolean
}

/** Shared visual shell for session-scoped assistant chats. */
export default function AssistantChatPanel({
  projectId, title, messages, running, stopping, input, sendError, copy,
  locale, config, permission, enhance, context, plan, availableCommands, attachmentPrefix, onInputChange, onSend, onStop, onAttachmentError, onClose,
  onA2uiAction, headerActions, afterMessages, scrollKey, quickPrompts, quickPromptsLabel,
  onQuickPromptSelect, a2uiMessages, showUserTag = false,
}: AssistantChatPanelProps) {
  const deviceId = useUserSettingsStore((state) => state.deviceId)
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const followRef = useRef(true)
  const lastProgrammaticScrollTopRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const lastContent = messages.at(-1)?.content ?? ''
  const respondInteraction = useCallback(async (
    interactionId: string,
    response: Record<string, unknown>,
  ) => {
    await taskApi.respondInteraction(interactionId, response, projectId)
  }, [projectId])

  useEffect(() => {
    if (!followRef.current) return
    const list = listRef.current
    if (!list) return
    const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
    lastProgrammaticScrollTopRef.current = target
    list.scrollTop = target
  }, [messages.length, lastContent, scrollKey])
  useEffect(() => {
    followRef.current = true
  }, [scrollKey])

  // 图片/媒体异步加载会撑高内容且不触发上面的跟随 effect，
  // 跟随中时在 capture 阶段监听 load 重新钉底。
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onMediaLoad = () => {
      if (!followRef.current) return
      const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
      lastProgrammaticScrollTopRef.current = target
      list.scrollTop = target
    }
    list.addEventListener('load', onMediaLoad, true)
    return () => list.removeEventListener('load', onMediaLoad, true)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)',
      }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13 }}>{title}</span>
        {running && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--meta)' }}>
            <span className="task-status-spinner" aria-hidden="true" /> {copy.thinking}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {headerActions}
        {onClose && <Button variant="icon" aria-label={copy.closePrompt} onClick={onClose}>✕</Button>}
      </div>

      <div
        className="chat-history-scroll"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget
          const nearBottom = isNearConversationBottom(
            list.scrollHeight,
            list.scrollTop,
            list.clientHeight,
          )
          // 编程滚动（跟随钉底）会触发 scroll 回显；此时内容可能又长高，
          // nearBottom 会误判为 false。只有位置偏离编程目标才算用户滚动。
          const programmaticEcho = Math.abs(
            list.scrollTop - lastProgrammaticScrollTopRef.current,
          ) <= 1
          if (!programmaticEcho) {
            // 用户向上滚动（scrollTop 减小）立即取消跟随：
            // 流式输出期间内容持续增长，等滚出阈值就永远滚不动。
            if (list.scrollTop < lastScrollTopRef.current) {
              followRef.current = false
            } else if (nearBottom) {
              followRef.current = true
            }
          }
          lastScrollTopRef.current = list.scrollTop
        }}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', paddingBlock: 10,
          display: 'flex', flexDirection: 'column', gap: 8,
          background: 'var(--bg)',
        }}
      >
        {messages.length === 0 && copy.emptyIntro && (
          <div style={{ fontSize: 13, color: 'var(--meta)', padding: '4px 2px', lineHeight: 1.6 }}>
            {copy.emptyIntro}
          </div>
        )}
        {messages.map((message) => {
          const ownUserMessage = !message.author_device_id || message.author_device_id === deviceId
          const userSender = ownUserMessage ? copy.me : (message.author_name || copy.me)
          return (
          <ChatMessageBubble
            key={message.id}
            role={message.role}
            sender={message.role === 'user' ? userSender : copy.agent}
            initials={message.role === 'user' ? (ownUserMessage ? copy.meInitials : userSender.slice(0, 2)) : copy.agentInitials}
            color={message.role === 'user' ? 'var(--accent)' : 'var(--ai-assistant)'}
            content={message.content}
            events={message.events}
            a2uiMessages={a2uiMessages?.[message.id]}
            onInteractionRespond={respondInteraction}
            streaming={message.status === 'running'}
            projectId={projectId}
            error={message.role === 'assistant' ? message.error : undefined}
            showLoading={message.role === 'assistant' && message.status === 'running'}
            loading={message.role === 'assistant'
              ? <div className="engine-loading-message" role="status">{copy.thinking}</div>
              : undefined}
            header={message.role === 'user' ? (
              <>
                {showUserTag && copy.tag && (
                  <span
                    title={copy.userTagTitle}
                    style={{
                      padding: '1px 6px', borderRadius: 999, fontSize: 11,
                      border: '1px solid var(--border-soft)',
                      background: 'rgba(124,58,237,0.08)', color: 'var(--ai-assistant)',
                    }}
                  >{copy.tag}</span>
                )}
                {formatConversationDateTime(message.created_at, Date.now(), locale)}
              </>
            ) : (
              <MessageMetaBar
                createdAt={message.created_at}
                endedAt={message.ended_at}
                running={message.status === 'running'}
                status={message.status === 'stopped' ? 'stopped' : message.status === 'error' ? 'failed' : undefined}
                events={message.events}
                prompt={message.prompt}
                onViewPrompt={setViewingPrompt}
              />
            )}
            footer={message.role === 'assistant' && message.status !== 'running' ? (
              <MessageResponseFooter
                content={stripA2uiBlocks(message.content)}
                usage={usageFromEvents(message.events ?? [])}
                engine={message.engine}
                model={message.model}
              />
            ) : undefined}
            onA2uiAction={onA2uiAction}
          />
          )
        })}
        {afterMessages}
      </div>

      {sendError && <div style={{ padding: '6px 12px', fontSize: 13, color: 'var(--danger)', background: 'var(--bg)' }}>{sendError}</div>}
      <div style={{
        flexShrink: 0, padding: '10px 12px',
        borderTop: '1px solid var(--border-soft)', background: 'var(--bg)',
      }}>
        {quickPrompts && quickPrompts.length > 0 && (
          <div
            className="chat-quick-prompts"
            role="group"
            aria-label={quickPromptsLabel}
            style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 1px 8px' }}
          >
            {quickPrompts.map((item) => (
              <Button
                key={item.label}
                type="button"
                size="sm"
                disabled={running}
                onClick={() => {
                  onQuickPromptSelect?.(item.prompt)
                  requestAnimationFrame(() => inputRef.current?.focus())
                }}
                style={{ flexShrink: 0, borderRadius: 999, whiteSpace: 'nowrap' }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )}
        <ChatInput
          projectId={projectId}
          availableCommands={availableCommands}
          inputRef={inputRef}
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          onStop={onStop}
          disabled={running}
          running={running}
          stopping={stopping}
          placeholder={copy.placeholder}
          imageAttach={{ projectId, prefix: attachmentPrefix, onError: onAttachmentError }}
          config={config}
          permission={permission}
          enhance={enhance}
          context={context}
          plan={plan}
        />
      </div>

      {viewingPrompt && (
        <div
          role="dialog" aria-modal="true" aria-label={copy.fullPrompt}
          style={{
            position: 'fixed', inset: 0, zIndex: 1450, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
          onClick={() => setViewingPrompt(null)}
        >
          <div
            style={{
              width: 'min(860px, 92vw)', maxHeight: '84vh', background: 'var(--bg)',
              borderRadius: 12, boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <strong style={{ flex: 1, fontSize: 13 }}>{copy.fullPrompt}</strong>
              <Button variant="icon" aria-label={copy.closePrompt} onClick={() => setViewingPrompt(null)}>✕</Button>
            </div>
            <div style={{ padding: 18, overflow: 'auto', fontSize: 13, lineHeight: 1.65 }}>
              <MarkdownMessage content={viewingPrompt} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
