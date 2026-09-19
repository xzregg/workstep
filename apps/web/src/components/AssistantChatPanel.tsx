import { useCompactLayout } from '../hooks/useCompactLayout'
import {
  ComposerOverlayHostContext,
  useComposerOverlayClearance,
} from '../hooks/useComposerOverlayClearance'
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import MobileSheet from './MobileSheet'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'

import type { AssistantChatMessage } from '../stores/assistantStore'
import { taskApi, type EngineInputItem } from '../api/client'
import { stripA2uiBlocks } from '../utils/a2ui'
import { formatConversationDateTime } from '../utils/datetime'
import {
  isAutoShrinkClamp,
  isNearConversationBottom,
  conversationBottomScrollTop,
  observeContentResize,
  shouldPauseConversationFollow,
} from '../pages/taskDetailChat'
import Button from './Button'
import ChatInput, {
  type ChatContextUsage,
  type ChatEngineQuota,
  type ChatInputEnhance,
  type ChatInputEngineConfig,
  type ChatInputPermission,
  type ChatInputPlan,
} from './ChatInput'
import ChatMessageBubble from './ChatMessageBubble'
import AssistantThinkingMessage from './AssistantThinkingMessage'
import StreamingStatusText from './StreamingStatusText'
import ConversationNewMessagesButton from './ConversationNewMessagesButton'
import MessageMetaBar from './MessageMetaBar'
import PromptViewerDialog from './PromptViewerDialog'
import MessageResponseFooter, { usageFromEvents } from './MessageResponseFooter'
import MarqueeText from './MarqueeText'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { shouldShowAssistantThinking } from '../utils/assistantThinking'
import { displayUserDetail, displayUserSender } from '../utils/actorDisplay'
import { useI18n } from '../i18n'

const COMPOSER_HEIGHT_KEY = 'workstep-chat-composer-height'
const MIN_COMPOSER_HEIGHT = 220
const MAX_COMPOSER_FRACTION = 0.85

function loadChatComposerHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(COMPOSER_HEIGHT_KEY)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

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
  /** Stable WorkStep conversation id shown in message metadata. */
  sessionId?: string | null
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
  quota?: ChatEngineQuota | null
  plan?: ChatInputPlan
  availableCommands?: EngineInputItem[]
  attachmentPrefix: string
  onInputChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  /** Allow messages to be inserted into the active engine turn. */
  allowSendWhileRunning?: boolean
  onAttachmentError?: (message: string) => void
  onClose?: () => void
  onA2uiAction?: (action: A2uiClientAction) => void
  headerActions?: ReactNode
  /** Assistant-specific controls rendered in the button row above the composer. */
  composerActions?: ReactNode
  /** Floating content anchored immediately above the composer. */
  composerOverlay?: ReactNode
  afterMessages?: ReactNode
  scrollKey?: string | number
  quickPrompts?: AssistantQuickPrompt[]
  quickPromptsLabel?: string
  onQuickPromptSelect?: (prompt: string) => void
  /** Store 累积的 A2UI 载荷（messageId → payload[]），随消息渲染。 */
  a2uiMessages?: Record<string, Record<string, unknown>[]>
  /** 用户消息上方是否显示身份标签（默认隐藏；仅任务详情对话与分享页显示）。 */
  showUserTag?: boolean
  /** Load one persisted message's JSONL process timeline on demand. */
  onLoadMessageEvents?: (messageId: string) => void
  /** Optional message-level fork action, shown on completed assistant replies. */
  onForkMessage?: (messageId: string) => void
}

interface MessageItemProps {
  message: AssistantChatMessage
  copy: AssistantChatCopy
  deviceId: string
  userName: string
  locale: string
  showUserTag: boolean
  projectId: string
  sessionId?: string | null
  a2uiEntry?: Record<string, unknown>[]
  respondInteraction: (
    interactionId: string,
    response: Record<string, unknown>,
  ) => Promise<void>
  onViewPrompt: (value: string | null) => void
  onLoadMessageEvents?: (messageId: string) => void
  onForkMessage?: (messageId: string) => void
  onSendToInput: (content: string) => void
  onA2uiAction?: (action: A2uiClientAction) => void
}

/**
 * 单条消息行（memo 化）。流式输出时每个 token 都会重建 messages 数组，但只有
 * 最后一条消息的对象引用在变；历史气泡靠 memo 整体跳过重渲染（含 markdown
 * 重新解析与 ProcessTrace 时间线），否则长对话会让主线程每个 token 卡一次，
 * 侧栏点击/页面切换都要排队。
 *
 * 注意：所有 props 必须引用稳定 —— copy 由调用方 useMemo，回调由 useCallback，
 * 否则 memo 失效（功能不受影响，只是回到全量重渲染）。
 */
const MessageItem = memo(function MessageItem({
  message, copy, deviceId, userName, locale, showUserTag, projectId, sessionId,
  a2uiEntry, respondInteraction, onViewPrompt, onLoadMessageEvents,
  onForkMessage, onSendToInput, onA2uiAction,
}: MessageItemProps) {
  const { t } = useI18n()
  const ownUserMessage = !message.author_device_id || message.author_device_id === deviceId
  const userSender = displayUserSender(message.author_name, userName, copy.me)
  return (
    <ChatMessageBubble
      role={message.role}
      sender={message.role === 'user' ? userSender : copy.agent}
      senderTitle={
        message.role === 'user'
          ? displayUserDetail(message.author_name, message.author_device_name, copy.me)
          : undefined
      }
      initials={message.role === 'user' ? (ownUserMessage ? copy.meInitials : userSender.slice(0, 2)) : copy.agentInitials}
      color={message.role === 'user' ? 'var(--accent)' : 'var(--ai-assistant)'}
      content={message.content}
      events={message.events}
      interactionsEnabled={message.status === 'running'}
      a2uiMessages={a2uiEntry}
      onInteractionRespond={respondInteraction}
      streaming={message.status === 'running'}
      projectId={projectId}
      error={message.role === 'assistant' ? message.error : undefined}
      showLoading={message.role === 'assistant' && message.status === 'running'}
      loading={message.role === 'assistant'
        ? <StreamingStatusText label={t('bubble.thinking')} />
        : undefined}
      header={message.role === 'user' ? (
        <>
          {showUserTag && copy.tag && (
            <span
              title={copy.userTagTitle}
              style={{
                padding: '1px 6px', borderRadius: 999, fontSize: 'calc(11px * var(--font-scale))',
                border: '1px solid var(--border-soft)',
                background: 'rgba(124,58,237,0.08)', color: 'var(--ai-assistant)',
              }}
            >{copy.tag}</span>
          )}
          {userSender !== copy.me && (
            <MarqueeText text={userSender} className="user-sender-marquee" />
          )}
          {formatConversationDateTime(message.created_at, Date.now(), locale)}
        </>
      ) : (
        <MessageMetaBar
          createdAt={message.created_at}
          endedAt={message.ended_at}
          sessionId={sessionId}
          messageId={message.id}
          running={message.status === 'running'}
          status={message.status === 'stopped' ? 'stopped' : message.status === 'error' ? 'failed' : undefined}
          events={message.events}
          eventSummary={message.event_summary}
          eventDetail={message.event_detail}
          onLoadEventDetails={onLoadMessageEvents
            ? () => onLoadMessageEvents(message.id)
            : undefined}
          prompt={message.prompt}
          onViewPrompt={onViewPrompt}
          projectId={projectId}
        />
      )}
      footer={
        message.role === 'assistant' &&
        // 思考中（尚无正文）也展示 Token / t/s / 引擎 * 模型
        (message.content || message.status === 'running' || message.status === 'stopped') ? (
          <MessageResponseFooter
            content={stripA2uiBlocks(message.content)}
            usage={usageFromEvents(message.events ?? [])}
            events={message.events ?? []}
            eventSummary={message.event_summary}
            engine={message.engine}
            model={message.model}
            startedAt={message.created_at}
            running={message.status === 'running'}
            stopped={message.status === 'stopped'}
            onFork={message.status === 'succeeded' && onForkMessage
              ? () => onForkMessage(message.id)
              : undefined}
          />
        ) : undefined
      }
      onSendToInput={onSendToInput}
      onA2uiAction={onA2uiAction}
    />
  )
})

/** Shared visual shell for session-scoped assistant chats. */
export default function AssistantChatPanel({
  projectId, sessionId, title, messages, running, stopping, input, sendError, copy,
  locale, config, permission, enhance, context, quota, plan, availableCommands, attachmentPrefix, onInputChange, onSend, onStop, onAttachmentError, onClose,
  onA2uiAction, headerActions, composerActions, composerOverlay, afterMessages, scrollKey, quickPrompts, quickPromptsLabel,
  onQuickPromptSelect, a2uiMessages, showUserTag = false,
  onLoadMessageEvents, onForkMessage, allowSendWhileRunning = false,
}: AssistantChatPanelProps) {
  const deviceId = useUserSettingsStore((state) => state.deviceId)
  const userName = useUserSettingsStore((state) => state.userName)
  const { t } = useI18n()
  const compactLayout = useCompactLayout()
  const [quickPromptsOpen, setQuickPromptsOpen] = useState(false)
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [awaitingReply, setAwaitingReply] = useState(false)
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false)
  const [scrolledToBottom, setScrolledToBottom] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const followRef = useRef(true)
  const lastProgrammaticScrollTopRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const composerInnerRef = useRef<HTMLDivElement>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(loadChatComposerHeight)
  const lastContent = messages.at(-1)?.content ?? ''
  const lastEventsCount = messages.at(-1)?.events?.length ?? 0
  // 输入区上方的悬浮面板（如「待插入消息」）会遮住会话底部：
  // 留白与跟随钉底走共用 hook，面板经插槽透传也能自行注册。
  const { registerOverlay, overlayPaddingBottom } = useComposerOverlayClearance({
    scrollRef: listRef,
    followRef,
    programmaticRef: lastProgrammaticScrollTopRef,
    scrollHeightRef: lastScrollHeightRef,
  })
  const showThinkingReply = shouldShowAssistantThinking(
    awaitingReply || running,
    messages,
  )
  const respondInteraction = useCallback(async (
    interactionId: string,
    response: Record<string, unknown>,
  ) => {
    await taskApi.respondInteraction(interactionId, response, projectId)
  }, [projectId])
  // MessageItem 是 memo 化的：这里的回调必须引用稳定，否则每个 token 都会击穿 memo。
  const handleSendToInput = useCallback((content: string) => {
    onInputChange(content)
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
  }, [onInputChange])

  useEffect(() => {
    const list = listRef.current
    if (!followRef.current) {
      if (list) lastScrollHeightRef.current = list.scrollHeight
      setHasUnreadMessages(true)
      return
    }
    if (!list) return
    const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
    lastProgrammaticScrollTopRef.current = target
    lastScrollHeightRef.current = list.scrollHeight
    list.scrollTop = target
    setScrolledToBottom(isNearConversationBottom(list.scrollHeight, target, list.clientHeight))
    setHasUnreadMessages(false)
  }, [messages.length, lastContent, lastEventsCount, scrollKey, a2uiMessages])

  // 移动端浏览器可能在首次渲染后调整 viewport（地址栏收缩等），
  // 多次延迟钉底确保消息列表在最新位置。
  useEffect(() => {
    if (!followRef.current) return
    const scrollToEnd = () => {
      const list = listRef.current
      if (!list || !followRef.current) return
      const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
      lastProgrammaticScrollTopRef.current = target
      lastScrollHeightRef.current = list.scrollHeight
      list.scrollTop = target
      setScrolledToBottom(isNearConversationBottom(list.scrollHeight, target, list.clientHeight))
    }
    const t1 = setTimeout(scrollToEnd, 50)
    const t2 = setTimeout(scrollToEnd, 200)
    const t3 = setTimeout(scrollToEnd, 500)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [messages.length, scrollKey])

  useEffect(() => {
    followRef.current = true
    setHasUnreadMessages(false)
  }, [scrollKey])
  useEffect(() => {
    if (messages.at(-1)?.role === 'assistant' || sendError) {
      setAwaitingReply(false)
    }
  }, [messages, sendError])

  // 图片/媒体异步加载会撑高内容且不触发上面的跟随 effect，
  // 跟随中时在 capture 阶段监听 load 重新钉底。
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onMediaLoad = () => {
      if (!followRef.current) return
      const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
      lastProgrammaticScrollTopRef.current = target
      lastScrollHeightRef.current = list.scrollHeight
      list.scrollTop = target
    }
    list.addEventListener('load', onMediaLoad, true)
    return () => list.removeEventListener('load', onMediaLoad, true)
  }, [])

  // 展开、折叠思考块 / 过程追踪等只改变内容高度，不会触发上面的消息数据
  // effect；用 ResizeObserver 监测内容高度变化，跟随中时重新钉底，
  // 避免运行中展开块后用户被顶出底部且无法滚回。
  useEffect(() => {
    return observeContentResize({
      containerRef: listRef,
      contentRef,
      onResize: ({ height }) => {
        const list = listRef.current
        if (!list || !followRef.current) return
        lastScrollHeightRef.current = height
        const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
        lastProgrammaticScrollTopRef.current = target
        list.scrollTop = target
        setScrolledToBottom(isNearConversationBottom(list.scrollHeight, target, list.clientHeight))
      },
    })
  }, [])

  // 持久化输入区高度；双击重置（null）会清除存储值。
  useEffect(() => {
    try {
      if (composerHeight === null) window.localStorage.removeItem(COMPOSER_HEIGHT_KEY)
      else window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(composerHeight)))
    } catch { /* localStorage 不可用 */ }
  }, [composerHeight])

  const clampComposerHeight = (height: number) => {
    const containerHeight = rootRef.current?.getBoundingClientRect().height
    const max = containerHeight
      ? Math.max(MIN_COMPOSER_HEIGHT, Math.round(containerHeight * MAX_COMPOSER_FRACTION))
      : height
    return Math.min(Math.max(MIN_COMPOSER_HEIGHT, height), max)
  }

  // 拖动中直接写 DOM 高度，避免每帧重渲染整个消息列表；松开时提交状态。
  const startComposerResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = composerRef.current?.getBoundingClientRect().height
      ?? composerHeight ?? MIN_COMPOSER_HEIGHT
    let latest = startHeight
    const onMove = (moveEvent: MouseEvent) => {
      latest = clampComposerHeight(startHeight + (startY - moveEvent.clientY))
      if (composerRef.current) composerRef.current.style.height = `${latest}px`
      if (composerInnerRef.current) {
        composerInnerRef.current.style.height = '100%'
        composerInnerRef.current.style.overflowY = 'auto'
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setComposerHeight(latest)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = ''
  }

  const resetComposerHeight = () => setComposerHeight(null)

  const handleComposerResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const base = composerRef.current?.getBoundingClientRect().height
      ?? composerHeight ?? MIN_COMPOSER_HEIGHT
    let next: number | null
    if (event.key === 'ArrowUp') next = base + 8
    else if (event.key === 'ArrowDown') next = base - 8
    else if (event.key === 'Escape' || event.key === 'Home') next = null
    else return
    event.preventDefault()
    setComposerHeight(next === null ? null : clampComposerHeight(next))
  }

  return (
    <div className="assistant-chat-panel" ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 12px', borderBottom: '1px solid var(--border-soft)', background: 'var(--bg)',
      }}>
        <span className="assistant-chat-header-title" title={title}>{title}</span>
        {running && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
            <span className="task-status-spinner" aria-hidden="true" /> {copy.thinking}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {headerActions}
        {onClose && <Button variant="icon" aria-label={copy.closePrompt} onClick={onClose}>✕</Button>}
      </div>

      {/* 输入区上方的悬浮面板（如「待插入消息」）会遮住会话底部：
          由包裹层留出「面板高度 + 10px」，滚动容器随之整体变矮。 */}
      <div className={`chat-history-wrapper${scrolledToBottom ? ' is-at-bottom' : ''}`} style={{ flex: 1, minHeight: 0, position: 'relative', paddingBottom: overlayPaddingBottom(5) }}>
        <div
          className="chat-history-scroll"
          ref={listRef}
          onWheelCapture={(event) => {
            if (shouldPauseConversationFollow({ type: 'wheel', deltaY: event.deltaY })) {
              followRef.current = false
            }
          }}
          onKeyDownCapture={(event) => {
            if (shouldPauseConversationFollow({ type: 'key', key: event.key })) {
              followRef.current = false
            }
          }}
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
            // 内容变矮（思考块折叠等）时浏览器自动把 scrollTop 钳制到新的底部，
            // 同样触发 scroll 事件；不能把它误判为用户上滚而取消跟随。
            const autoShrinkClamp = isAutoShrinkClamp({
              scrollTop: list.scrollTop,
              prevScrollTop: lastScrollTopRef.current,
              scrollHeight: list.scrollHeight,
              prevScrollHeight: lastScrollHeightRef.current,
              clientHeight: list.clientHeight,
            })
            if (!programmaticEcho) {
              // 用户向上滚动（scrollTop 减小）立即取消跟随：
              // 流式输出期间内容持续增长，等滚出阈值就永远滚不动。
              if (list.scrollTop < lastScrollTopRef.current) {
                if (autoShrinkClamp) {
                  // 自动钳制落底：同步基准值，后续回显仍按程序滚动识别。
                  lastProgrammaticScrollTopRef.current = list.scrollTop
                } else if (
                  // 内容变高（展开折叠项 / 思考块等）时浏览器的 scroll anchoring
                  // 可能做微小的向上锚定调整，不应误判为用户主动上滚而取消跟随。
                  list.scrollHeight > lastScrollHeightRef.current &&
                  lastScrollTopRef.current - list.scrollTop <= 2
                ) {
                  // 忽略内容变高时的微小锚定调整，保持跟随状态。
                } else {
                  followRef.current = false
                }
              }
            }
            // 接近底部时恢复跟随：必须放在 programmaticEcho 判断之外。
            // 展开折叠项导致内容高度变化后，用户向下滚回底部时，scrollTop
            // 可能恰好等于上一次程序钉底的位置（programmaticEcho=true），
            // 若在此分支内判断会被跳过，导致跟随永远无法恢复、自动滚动失效。
            if (list.scrollTop >= lastScrollTopRef.current && nearBottom) {
              if (!followRef.current) {
                followRef.current = true
                setHasUnreadMessages(false)
              }
            }
            setScrolledToBottom(nearBottom)
            lastScrollTopRef.current = list.scrollTop
            lastScrollHeightRef.current = list.scrollHeight
          }}
          style={{
            height: '100%', minHeight: 0, overflowY: 'auto', paddingBlock: 10,
            display: 'flex', flexDirection: 'column',
            background: 'var(--bg)',
          }}
        >
          <div
            ref={contentRef}
            className="chat-history-content"
            style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: '100%' }}
          >
          {messages.length === 0 && copy.emptyIntro && (
            <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', padding: '4px 2px', lineHeight: 1.6 }}>
              {copy.emptyIntro}
            </div>
          )}
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              copy={copy}
              deviceId={deviceId}
              userName={userName}
              locale={locale}
              showUserTag={showUserTag}
              projectId={projectId}
              sessionId={sessionId}
              a2uiEntry={a2uiMessages?.[message.id]}
              respondInteraction={respondInteraction}
              onViewPrompt={setViewingPrompt}
              onLoadMessageEvents={onLoadMessageEvents}
              onForkMessage={onForkMessage}
              onSendToInput={handleSendToInput}
              onA2uiAction={onA2uiAction}
            />
          ))}
          {showThinkingReply && (
            <AssistantThinkingMessage
              sender={copy.agent}
              initials={copy.agentInitials}
              footer={config.engine || config.defaultEngine || config.model ? (
                <MessageResponseFooter
                  content=""
                  engine={config.engine || config.defaultEngine || null}
                  model={config.model || null}
                  running
                />
              ) : undefined}
            />
          )}
          {afterMessages}
          </div>
        </div>
        <ConversationNewMessagesButton
          visible={!scrolledToBottom}
          hasNewMessages={hasUnreadMessages}
          label={t('taskDetail.newMessages')}
          ariaLabel={t('taskDetail.viewNewMessagesAria')}
          onClick={() => {
            followRef.current = true
            setHasUnreadMessages(false)
            const list = listRef.current
            if (!list) return
            const target = conversationBottomScrollTop(list.scrollHeight, list.clientHeight)
            lastProgrammaticScrollTopRef.current = target
            list.scrollTo({ top: target, behavior: 'smooth' })
          }}
        />
      </div>

      {sendError && <div style={{ padding: '6px 12px', fontSize: 'calc(13px * var(--font-scale))', color: 'var(--danger)', background: 'var(--bg)' }}>{sendError}</div>}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('layout.dragResizeComposer')}
        title={t('layout.dragResizeComposer')}
        tabIndex={0}
        onMouseDown={startComposerResize}
        onDoubleClick={resetComposerHeight}
        onKeyDown={handleComposerResizeKey}
        className="chat-composer-resize-handle"
        style={{
          height: 2, flexShrink: 0, cursor: 'row-resize',
          background: 'var(--border-soft)',        }}
      />

      <div
        ref={composerRef}
        style={{
          position: 'relative', flexShrink: 0,
          height: compactLayout ? 'auto' : composerHeight ?? 'auto',
          background: 'var(--bg)',
        }}
      >
        <ComposerOverlayHostContext.Provider value={registerOverlay}>
          {composerOverlay}
        </ComposerOverlayHostContext.Provider>
        <div
          ref={composerInnerRef}
          style={{
            height: compactLayout ? 'auto' : composerHeight ?? 'auto',
            overflowY: 'visible',
            display: 'flex', flexDirection: 'column',
            padding: compactLayout ? '0' : '12px 12px',
          }}
        >
          {(composerActions || (quickPrompts && quickPrompts.length > 0)) && !compactLayout && (
              <div
                className="chat-quick-prompts"
                role="group"
                aria-label={quickPromptsLabel}
                style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 1px 8px' }}
              >
                {composerActions}
                {quickPrompts?.map((item) => (
                  <Button
                    key={item.label}
                    type="button"
                    size="sm"
                    disabled={running}
                    onClick={() => {
                      onQuickPromptSelect?.(item.prompt)
                      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
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
            sessionId={sessionId}
            availableCommands={availableCommands}
            inputRef={inputRef}
            value={input}
            onChange={onInputChange}
            onSend={() => {
              if (!input.trim() || (running && !allowSendWhileRunning)) return
              followRef.current = true
              setHasUnreadMessages(false)
              setAwaitingReply(true)
              onSend()
            }}
            onStop={onStop}
            disabled={running && !allowSendWhileRunning}
            running={running}
            allowSendWhileRunning={allowSendWhileRunning}
            stopping={stopping}
            placeholder={copy.placeholder}
            imageAttach={{ projectId, prefix: attachmentPrefix, onError: onAttachmentError }}
            config={config}
            permission={permission}
            enhance={enhance}
            context={context}
            quota={quota}
            plan={plan}
            left={compactLayout && quickPrompts && quickPrompts.length > 0 ? (
              <>
                <button
                  type="button"
                  className="chat-quick-bolt"
                  disabled={running}
                  onClick={() => setQuickPromptsOpen(true)}
                  aria-label={quickPromptsLabel}
                  style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', color: 'var(--meta)', cursor: running ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 'calc(14px * var(--font-scale))', padding: 0 }}
                >
                  ⚡
                </button>
                <MobileSheet open={quickPromptsOpen} title={quickPromptsLabel || t('chatSession.quickPromptsLabel')} onClose={() => setQuickPromptsOpen(false)}>
                  {quickPrompts.map((item) => (
                    <Button
                      key={item.label}
                      variant="ghost"
                      onClick={() => {
                        setQuickPromptsOpen(false)
                        onQuickPromptSelect?.(item.prompt)
                        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
                      }}
                      style={{ justifyContent: 'flex-start' }}
                    >
                      {item.label}
                    </Button>
                  ))}
                </MobileSheet>
              </>
            ) : undefined}
          />
        </div>
      </div>

      {viewingPrompt && (
        <PromptViewerDialog
          prompt={viewingPrompt}
          projectId={projectId}
          title={copy.fullPrompt}
          closeLabel={copy.closePrompt}
          zIndex={1450}
          onClose={() => setViewingPrompt(null)}
        />
      )}
    </div>
  )
}
