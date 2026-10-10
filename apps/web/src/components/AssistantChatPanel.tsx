import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useChatComposerResize } from '../hooks/useChatComposerResize'
import { useAssistantPendingInserts } from '../hooks/useAssistantPendingInserts'
import {
  ComposerOverlayHostContext,
  useComposerOverlayClearance,
} from '../hooks/useComposerOverlayClearance'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import MobileSheet from './MobileSheet'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'

import type { AssistantChatMessage } from '../stores/assistantStore'
import { taskApi, type ActionRun, type EngineInputItem } from '../api/client'
import { stripA2uiBlocks } from '../utils/a2ui'
import { formatConversationDateTime } from '../utils/datetime'
import {
  isAutoShrinkClamp,
  isNearConversationBottom,
  conversationBottomScrollTop,
  observeContentResize,
  shouldPauseConversationFollow,
} from '../utils/conversationScroll'
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
import { resolveMessageError } from '../pages/taskDetailChat'
import QuickPromptButton from './QuickPromptButton'
import { ActionConversationMessage } from './TaskActionShortcuts'
import { actionConversationScrollKey, mergeActionMessages } from '../utils/actionConversation'

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
  content?: string
  id?: string
  kind?: 'prompt' | 'display' | 'action'
  disabled?: boolean
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
  onRefreshQuota?: () => void
  quotaRefreshing?: boolean
  plan?: ChatInputPlan
  goal?: ChatInputPlan
  availableCommands?: EngineInputItem[]
  attachmentPrefix: string
  onInputChange: (value: string) => void
  onSend: () => void
  onSendContent: (content: string, pendingInsertIds: string[]) => Promise<boolean>
  onStop: () => void
  /** Allow messages to be inserted into the active engine turn. */
  allowSendWhileRunning?: boolean
  onAttachmentError?: (message: string) => void
  onClose?: () => void
  onA2uiAction?: (action: A2uiClientAction) => void
  headerContext?: ReactNode
  headerActions?: ReactNode
  /** Assistant-specific controls rendered in the button row above the composer. */
  composerActions?: ReactNode
  /** Floating content anchored immediately above the composer. */
  composerOverlay?: ReactNode
  composerStatus?: ReactNode
  afterMessages?: ReactNode
  actionRuns?: ActionRun[]
  onStopAction?: (runId: string) => void
  scrollKey?: string | number
  quickPrompts?: AssistantQuickPrompt[]
  quickPromptsLabel?: string
  onQuickPromptSelect?: (prompt: string) => void
  onQuickPromptItemSelect?: (item: AssistantQuickPrompt) => void
  /** Store 累积的 A2UI 载荷（messageId → payload[]），随消息渲染。 */
  a2uiMessages?: Record<string, Record<string, unknown>[]>
  /** 用户消息上方是否显示身份标签（默认隐藏；仅任务详情对话与分享页显示）。 */
  showUserTag?: boolean
  /** Load one persisted message's JSONL process timeline on demand. */
  onLoadMessageEvents?: (messageId: string) => void
  /** Fetch older messages; capture the scroll position immediately before prepending. */
  onLoadOlderHistory?: (beforePrepend?: () => void) => Promise<void>
  /** Optional message-level fork action, shown on completed assistant replies. */
  onForkMessage?: (messageId: string, preferSmart?: boolean) => void
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
  onForkMessage?: (messageId: string, preferSmart?: boolean) => void
  onSendToInput: (content: string) => void
  onAsyncQuestionSubmit: (content: string) => Promise<boolean>
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
  onForkMessage, onSendToInput, onAsyncQuestionSubmit, onA2uiAction,
}: MessageItemProps) {
  const { t } = useI18n()
  const { canEdit } = useGatewayProjectPermissions(projectId)
  const ownUserMessage = !message.author_device_id || message.author_device_id === deviceId
  const userSender = displayUserSender(
    message.author_name, userName, copy.me, t('aiFlow.historicalUser'),
  )
  return (
    <ChatMessageBubble
      role={message.role}
      sender={message.role === 'user' ? userSender : copy.agent}
      senderTitle={
        message.role === 'user'
          ? displayUserDetail(
              message.author_name, message.author_device_name,
              t('aiFlow.historicalUser'), message.author_username,
            )
          : undefined
      }
      initials={message.role === 'user' ? (ownUserMessage ? copy.meInitials : userSender.slice(0, 2)) : copy.agentInitials}
      color={message.role === 'user' ? 'var(--accent)' : 'var(--ai-assistant)'}
      content={message.content}
      events={message.events}
      interactionsEnabled={canEdit && message.status === 'running'}
      a2uiMessages={a2uiEntry}
      onInteractionRespond={canEdit ? respondInteraction : undefined}
      streaming={message.status === 'running'}
      projectId={projectId}
      error={
        message.role === 'assistant'
          ? message.error || resolveMessageError(message.events)
          : undefined
      }
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
        // 无正文、失败或停止的助手回复也保留元信息与分叉操作。
        message.role === 'assistant' ? (
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
            onFork={message.status !== 'running' && onForkMessage
              ? () => onForkMessage(message.id, message.status === 'error')
              : undefined}
          />
        ) : undefined
      }
      onSendToInput={onSendToInput}
      onAsyncQuestionSubmit={onAsyncQuestionSubmit}
      onA2uiAction={canEdit ? onA2uiAction : undefined}
    />
  )
})

/** Shared visual shell for session-scoped assistant chats. */
export default function AssistantChatPanel({
  projectId, sessionId, title, messages, running, stopping, input, sendError, copy,
  locale, config, permission, enhance, context, quota, onRefreshQuota, quotaRefreshing, plan, goal, availableCommands, attachmentPrefix, onInputChange, onSend, onSendContent, onStop, onAttachmentError, onClose,
  onA2uiAction, headerContext, headerActions, composerActions, composerStatus, composerOverlay, afterMessages, actionRuns, onStopAction, scrollKey, quickPrompts, quickPromptsLabel,
  onQuickPromptSelect, onQuickPromptItemSelect, a2uiMessages, showUserTag = false,
  onLoadMessageEvents, onLoadOlderHistory, onForkMessage, allowSendWhileRunning = false,
}: AssistantChatPanelProps) {
  const deviceId = useUserSettingsStore((state) => state.deviceId)
  const userName = useUserSettingsStore((state) => state.userName)
  const { t } = useI18n()
  const { canEdit } = useGatewayProjectPermissions(projectId)
  const engineMessages = messages.filter((message) => message.engine !== 'action')
  const { panel: pendingPanel, error: pendingError, queueEnabled, queueCurrentInput } = useAssistantPendingInserts({
    projectId, sessionId, messages, input, onInputChange, onSendContent,
  })

  const effectiveAllowSendWhileRunning = Boolean(allowSendWhileRunning || queueEnabled)
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
  const prependHeightRef = useRef<number | null>(null)
  const prependedRef = useRef(false)
  const {
    rootRef, composerRef, composerInnerRef, height: composerHeight,
    startResize: startComposerResize, resetHeight: resetComposerHeight,
    handleResizeKey: handleComposerResizeKey,
  } = useChatComposerResize()
  const lastContent = messages.at(-1)?.content ?? ''
  const lastEventsCount = messages.at(-1)?.events?.length ?? 0
  const actionScrollKey = actionConversationScrollKey(actionRuns)
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
    engineMessages,
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
  const handleAsyncQuestionSubmit = useCallback((content: string) => (
    onSendContent(content, [])
  ), [onSendContent])

  useLayoutEffect(() => {
    const list = listRef.current
    const previousHeight = prependHeightRef.current
    if (!list || previousHeight === null) return
    const target = list.scrollTop + list.scrollHeight - previousHeight
    list.scrollTop = target
    lastProgrammaticScrollTopRef.current = target
    lastScrollTopRef.current = target
    lastScrollHeightRef.current = list.scrollHeight
    prependHeightRef.current = null
    prependedRef.current = true
  }, [messages])

  useEffect(() => {
    if (prependedRef.current) {
      prependedRef.current = false
      return
    }
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
  }, [messages.length, lastContent, lastEventsCount, scrollKey, a2uiMessages, actionScrollKey])

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
    if (engineMessages.at(-1)?.role === 'assistant' || sendError) {
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

  const conversationMessages = actionRuns
    ? mergeActionMessages(
      messages,
      actionRuns,
      (message) => message.engine === 'action',
      (run, role): AssistantChatMessage => ({
        id: role === 'user' ? run.user_message_id : run.reply_message_id,
        role,
        engine: 'action',
        content: role === 'user' ? t('actionShortcuts.runTitle', { title: run.title }) : run.output,
        status: role === 'user' ? 'succeeded' : ['preparing', 'running', 'stopping'].includes(run.status) ? 'running' : run.status === 'succeeded' ? 'succeeded' : run.status === 'stopped' ? 'stopped' : 'error',
        created_at: run.started_at,
        ended_at: role === 'assistant' ? run.ended_at || undefined : run.started_at,
      }),
    )
    : messages

  return (
    <div className="assistant-chat-panel" ref={rootRef}>
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

      {headerContext}

      {/* 输入区上方的悬浮面板（如「待插入消息」）会遮住会话底部：
          由包裹层留出「面板高度 + 10px」，滚动容器随之整体变矮。 */}
      <div className={`chat-history-wrapper${scrolledToBottom ? ' is-at-bottom' : ''}`} style={{ flex: 1, minHeight: 0, position: 'relative', paddingBottom: overlayPaddingBottom(5) }}>
        <div
          className={`chat-history-scroll chat-history-scroll--assistant${onLoadOlderHistory ? ' chat-history-scroll--paged' : ''}`}
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
            if (list.scrollTop <= 40 && onLoadOlderHistory) {
              void onLoadOlderHistory(() => {
                followRef.current = false
                prependHeightRef.current = list.scrollHeight
              })
            }
          }}
        >
          <div
            ref={contentRef}
            className="chat-history-content chat-history-content--assistant"
          >
          {conversationMessages.length === 0 && copy.emptyIntro && (
            <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)', padding: '4px 2px', lineHeight: 1.6 }}>
              {copy.emptyIntro}
            </div>
          )}
          {conversationMessages.map((message) => message.engine === 'action' ? (
            <ActionConversationMessage
              key={message.id}
              message={message}
              run={(message as AssistantChatMessage & { actionRun?: ActionRun }).actionRun}
              onStop={canEdit ? onStopAction : undefined}
            />
          ) : (
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
              onForkMessage={canEdit ? onForkMessage : undefined}
              onSendToInput={handleSendToInput}
              onAsyncQuestionSubmit={handleAsyncQuestionSubmit}
              onA2uiAction={canEdit ? onA2uiAction : undefined}
            />
          ))}
          {showThinkingReply && (
            <AssistantThinkingMessage
              sender={copy.agent}
              initials={copy.agentInitials}
              startedAt={engineMessages.at(-1)?.created_at}
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

      {(sendError || pendingError) && <div className="assistant-chat-error">{sendError || pendingError}</div>}
      {canEdit && <>
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
      />

      <div
        ref={composerRef}
        className="chat-composer-outer"
        style={!compactLayout && composerHeight !== null ? { height: composerHeight } : undefined}
      >
        <ComposerOverlayHostContext.Provider value={registerOverlay}>
          {pendingPanel}
          {composerOverlay}
        </ComposerOverlayHostContext.Provider>
        <div
          ref={composerInnerRef}
          className={`chat-composer-inner${!compactLayout && composerHeight !== null ? ' is-resized' : ''}${compactLayout ? ' is-compact' : ''}`}
        >
          {composerStatus}
          {(composerActions || (quickPrompts && quickPrompts.length > 0)) && !compactLayout && (
              <div
                className="chat-quick-prompts"
                role="group"
                aria-label={quickPromptsLabel}
                style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 1px 8px' }}
              >
                {composerActions}
                {quickPrompts?.map((item) => (
                  <QuickPromptButton
                    key={item.id || item.label}
                    disabled={item.disabled ?? (item.kind === 'action' ? false : running)}
                    label={item.label}
                    prompt={item.kind === 'action' ? item.id || '' : item.prompt}
                    displayOnly={item.kind === 'display'}
                    displayContent={item.content}
                    onSelect={(prompt) => {
                      if (onQuickPromptItemSelect) onQuickPromptItemSelect(item)
                      else onQuickPromptSelect?.(prompt)
                      if (item.kind !== 'action') requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
                    }}
                    style={{ flexShrink: 0, borderRadius: 999, whiteSpace: 'nowrap' }}
                  />
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
              if (!input.trim() || (running && !effectiveAllowSendWhileRunning)) return
              followRef.current = true
              setHasUnreadMessages(false)
              if (running && queueEnabled) {
                void queueCurrentInput()
              } else {
                setAwaitingReply(true)
                onSend()
              }
            }}
            onStop={onStop}
            disabled={running && !effectiveAllowSendWhileRunning}
            running={running}
            allowSendWhileRunning={effectiveAllowSendWhileRunning}
            stopping={stopping}
            placeholder={copy.placeholder}
            imageAttach={{ projectId, prefix: attachmentPrefix, onError: onAttachmentError }}
            config={config}
            permission={permission}
            enhance={enhance}
            context={context}
            quota={quota}
            onRefreshQuota={onRefreshQuota}
            quotaRefreshing={quotaRefreshing}
            plan={plan}
            goal={goal}
            left={compactLayout && quickPrompts && quickPrompts.length > 0 ? (
              <>
                <button
                  type="button"
                  className="chat-quick-bolt"
                  disabled={running && !quickPrompts.some((item) => item.kind === 'action' && !item.disabled)}
                  onClick={() => setQuickPromptsOpen(true)}
                  aria-label={quickPromptsLabel}
                  style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', color: 'var(--meta)', cursor: running ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 'calc(14px * var(--font-scale))', padding: 0 }}
                >
                  ⚡
                </button>
                <MobileSheet open={quickPromptsOpen} title={quickPromptsLabel || t('chatSession.quickPromptsLabel')} onClose={() => setQuickPromptsOpen(false)}>
                  {quickPrompts.map((item) => (
                    <QuickPromptButton
                      key={item.id || item.label}
                      label={item.label}
                      prompt={item.kind === 'action' ? item.id || '' : item.prompt}
                      displayOnly={item.kind === 'display'}
                      displayContent={item.content}
                      disabled={item.disabled ?? (item.kind === 'action' ? false : running)}
                      onSelect={(prompt) => {
                        setQuickPromptsOpen(false)
                        if (onQuickPromptItemSelect) onQuickPromptItemSelect(item)
                        else onQuickPromptSelect?.(prompt)
                        if (item.kind !== 'action') requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
                      }}
                      style={{ justifyContent: 'flex-start', width: '100%' }}
                    />
                  ))}
                </MobileSheet>
              </>
            ) : undefined}
          />
        </div>
      </div>

      </>}

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
