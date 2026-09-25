import { useCallback, useState } from 'react'
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import A2uiMessage from './A2uiMessage'
import ImagePreview from './ImagePreview'
import MarqueeText from './MarqueeText'
import MarkdownMessage from './MarkdownMessage'
import MessageTimeline from './MessageTimeline'
import { MessageCopyButton } from './MessageResponseFooter'
import StreamingStatusText from './StreamingStatusText'
import {
  hasA2uiBlocks,
  isHiddenA2uiActionMessage,
  stripAssistantPayloadsForDisplay,
} from '../utils/a2ui'
import { isToolEvent } from '../utils/agui.ts'
import Icon from './Icon'
import InteractionPrompt from './InteractionPrompt'
import PlanChecklist from './PlanChecklist'
import {
  pendingInteractionItems,
  type InteractionEvent,
} from '../utils/interaction'
import { useI18n } from '../i18n'
import { latestMarkdownPlanFromEvents, latestPlanFromEvents } from '../utils/plan'
import { latestGoalFromEvents } from '../utils/goal'
import { visibleAssistantContent } from '../utils/chatMessageDisplay'
import { asyncQuestionAnswer, asyncQuestionsFromEvents } from '../utils/asyncQuestion'

/* ══════════════════════════════════════════
   ChatMessageBubble — shared conversation message
   row (avatar + bubble). Used by the task detail
   conversation and the AI flow-design chat so both
   render replies in the same style.
   ══════════════════════════════════════════ */

export type ChatMessageRootProps = HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement>
  [dataAttr: `data-${string}`]: string | number | boolean | undefined
}

export interface ChatMessageBubbleProps {
  role: 'user' | 'assistant' | 'system' | 'review'
  /** Display name / avatar title. */
  sender: string
  /** Optional richer avatar tooltip, such as sender and device name. */
  senderTitle?: string
  /** Avatar text (initials). */
  initials: string
  /** Avatar background color. */
  color: string
  content: string
  streaming?: boolean
  /** Project id used to resolve `.workstep/uploads/...` image paths. */
  projectId?: string
  /** Error text rendered under the bubble (assistant only). */
  error?: string
  /** Recovery actions rendered under the error (assistant only). */
  errorActions?: ReactNode
  /** Optional badge rendered on the avatar's bottom-right corner. */
  badge?: ReactNode
  /** User: tagline above the row. Assistant: meta bar above the content. */
  header?: ReactNode
  /** Rendered under the bubble content (e.g. usage footer). */
  footer?: ReactNode
  /** Rendered at the bottom of the message column (e.g. proposal cards). */
  children?: ReactNode
  /** Whether to show the loading indicator while streaming with no content. */
  showLoading?: boolean
  /** Custom loading indicator. */
  loading?: ReactNode
  /** User messages: edit action (loads the content back into the composer). */
  onEdit?: (content: string) => void
  /** User messages: reuse action (loads the content into the composer). */
  onSendToInput?: (content: string) => void
  /** Submit a Codex asynchronous question as a conversation reply. */
  onAsyncQuestionSubmit?: (content: string) => Promise<boolean>
  /** Receives user-initiated A2UI actions rendered inside the bubble. */
  onA2uiAction?: (action: A2uiClientAction) => void
  /** Engine interaction requests persisted in this message's event stream. */
  events?: InteractionEvent[]
  /** Store 累积的 A2UI 载荷，按 messageId 渲染（fence 仅作回退）。 */
  a2uiMessages?: Record<string, unknown>[]
  /** Submit an ACP permission or elicitation response. */
  onInteractionRespond?: (
    interactionId: string,
    response: Record<string, unknown>,
  ) => Promise<void>
  interactionsEnabled?: boolean
  /** Bubble background: 'surface' (default) or 'bg' (+ border). */
  variant?: 'surface' | 'bg'
  /** Extra props for the root element (ref / data attributes). */
  rootProps?: ChatMessageRootProps
}

function MessageAvatar({
  sender,
  senderTitle,
  initials,
  color,
  badge,
  showTooltip,
}: {
  sender: string
  senderTitle?: string
  initials: string
  color: string
  badge?: ReactNode
  showTooltip: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const label = senderTitle || sender
  return (
    <span
      className="chat-message-avatar-anchor"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {showTooltip && hovered && (
        <span className="chat-message-avatar-tooltip-wrap">
          <span role="tooltip" className="chat-message-avatar-tooltip">
            <MarqueeText text={label} forceActive speed={48} />
          </span>
        </span>
      )}
      <div
        aria-label={label}
        style={{
          width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
          background: color, color: 'var(--accent-fg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, position: 'relative',
        }}
      >
        {initials}
        {badge && (
          <span style={{
            position: 'absolute', right: -4, bottom: -4,
            width: 16, height: 16, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--ai-assistant)', color: 'var(--accent-fg)',
            border: '2px solid var(--bg)',
            fontSize: 'calc(11px * var(--font-scale))', fontWeight: 800, lineHeight: 1,
          }}>
            {badge}
          </span>
        )}
      </div>
    </span>
  )
}

export default function ChatMessageBubble({
  role,
  sender,
  senderTitle,
  initials,
  color,
  content,
  streaming = false,
  projectId,
  error,
  errorActions,
  badge,
  header,
  footer,
  children,
  showLoading = false,
  loading,
  onSendToInput,
  onAsyncQuestionSubmit,
  onA2uiAction,
  interactionsEnabled = true,
  events = [],
  a2uiMessages,
  onInteractionRespond,
  variant = 'surface',
  rootProps,
}: ChatMessageBubbleProps) {
  const { t } = useI18n()
  const isUser = role === 'user'
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null)
  const [asyncAnswers, setAsyncAnswers] = useState<Record<number, string>>({})
  const [asyncSubmitting, setAsyncSubmitting] = useState(false)
  const [asyncSubmitted, setAsyncSubmitted] = useState(false)
  const [asyncSubmitError, setAsyncSubmitError] = useState('')
  // 稳定引用：MarkdownMessage 已 memo 化，内联箭头会每次击穿 memo 让历史消息重新解析 markdown。
  const handleImageClick = useCallback((src: string, alt: string) => {
    setPreviewImage({ src, alt })
  }, [])
  const interactions = pendingInteractionItems(events, interactionsEnabled)
  const asyncQuestions = asyncQuestionsFromEvents(events)
  const plan = latestPlanFromEvents(events)
  const goal = latestGoalFromEvents(events)
  const markdownPlan = latestMarkdownPlanFromEvents(events)
  const hasToolActivity = !isUser && events.some((event) => (
    event.type === 'tool_use' || event.type === 'tool_result'
    || isToolEvent(event)
  ))
  if (isUser && isHiddenA2uiActionMessage(content)) return null
  const visibleContent = isUser ? content : visibleAssistantContent(content, error)
  const rootStyle: CSSProperties = {
    width: isUser ? 'fit-content' : '100%',
    maxWidth: '100%', minWidth: 0,
    display: 'flex', flexDirection: 'column', gap: 4,
    ...(rootProps?.style || {}),
    // 用户消息强制右对齐：alignSelf 依赖父容器为 flex，marginLeft auto 在
    // 任意容器下都能贴右，两者叠加保证任何调用场景都不偏左。
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    ...(isUser ? { marginLeft: 'auto' } : {}),
  }
  return (
    <div {...rootProps} style={rootStyle} className="chat-message-row" data-thinking={!isUser && showLoading && streaming && interactions.length === 0 && asyncQuestions.length === 0 && !plan && !markdownPlan && !(visibleContent || hasToolActivity) ? '' : undefined}>
      {isUser && header && (
        <div style={{
          fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', textAlign: 'right',
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6,
        }}>
          {header}
        </div>
      )}
      <div style={{
        width: isUser ? 'fit-content' : '100%',
        maxWidth: '100%', minWidth: 0,
        display: 'flex', gap: 12,
        flexDirection: isUser ? 'row-reverse' : 'row',
        alignSelf: isUser ? 'flex-end' : undefined,
      }}>
        <MessageAvatar
          sender={sender}
          senderTitle={senderTitle}
          initials={initials}
          color={color}
          badge={badge}
          showTooltip={isUser}
        />
        <div style={{
          flex: isUser ? '0 1 auto' : 1,
          minWidth: 0, display: 'flex', maxWidth: isUser ? '700px': '100%',
          flexDirection: 'column', gap: 6,
          alignItems: isUser ? 'flex-end' : 'stretch',
        }}>
          {!isUser && header && (
            // 元信息栏放在头像右侧、消息上方。
            <div style={{ width: '100%' }}>
              {header}
            </div>
          )}
          {(visibleContent || hasToolActivity) ? (
            <div className={isUser ? 'chat-bubble chat-bubble--user' : 'chat-bubble chat-bubble--assistant'} style={{
              fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.6,
              color: isUser ? 'var(--fg)' : 'var(--fg-2)',
              background: isUser ? 'var(--surface)' : 'var(--bg)',
              border: !isUser && variant === 'bg' ? '1px solid var(--border-soft)' : 'none',
              padding: '0px', borderRadius: isUser ? 12 :0 ,
              width: isUser ? 'fit-content' : undefined,
              minWidth: 0, maxWidth: '100%', overflow: 'hidden',
            }}>
              {isUser ? (
                <MarkdownMessage
                  content={content}
                  projectId={projectId}
                  className="user-message-markdown"
                  plainText
                  onImageClick={handleImageClick}
                />
              ) : (
                <>
                  <MessageTimeline
                    content={stripAssistantPayloadsForDisplay(visibleContent)}
                    events={events}
                    streaming={streaming}
                    projectId={projectId}
                  />
                  {(hasA2uiBlocks(content) || (a2uiMessages && a2uiMessages.length > 0)) && (
                    <A2uiMessage
                      content={content}
                      messages={a2uiMessages}
                      projectId={projectId}
                      onAction={onA2uiAction}
                    />
                  )}
                </>
              )}
            </div>
          ) : (
            !isUser && showLoading && streaming && interactions.length === 0 && !plan && !markdownPlan && (
              loading ?? (
                <StreamingStatusText label={t('bubble.thinking')} />
              )
            )
          )}
          {isUser && content && (
            // 预留固定高度的操作行，hover 时显示消息操作，不撑开下方布局。
            <div style={{
              display: 'flex', justifyContent: 'flex-end',
              alignItems: 'center', gap: 2, minHeight: 24,
            }}>
              {onSendToInput && (
                <button
                  type="button"
                  className="chat-message-action"
                  title={t('bubble.sendToInput')}
                  aria-label={t('bubble.sendToInput')}
                  onClick={() => onSendToInput(content)}
                  style={{
                    width: 24, height: 24, minWidth: 24, padding: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: 6,
                    color: 'var(--muted)', cursor: 'pointer',
                  }}
                >
                  <Icon name="send" size={12} strokeWidth={2} />
                </button>
              )}
              <MessageCopyButton content={content} className="chat-message-action" />
            </div>
          )}
          {!isUser && error && (
            <div style={{ color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))', marginTop: 4 }}>{error}</div>
          )}
          {!isUser && error && errorActions}
          {!isUser && markdownPlan && (
            <section className="chat-proposed-plan" aria-label={t('plan.proposalTitle')}>
              <div className="chat-proposed-plan-header">
                <div className="chat-proposed-plan-title">{t('plan.proposalTitle')}</div>
                <MessageCopyButton content={markdownPlan.content} className="chat-message-action" />
              </div>
              <MarkdownMessage
                content={markdownPlan.content}
                projectId={projectId}
                streaming={streaming && !markdownPlan.complete}
                onImageClick={handleImageClick}
              />
            </section>
          )}
          {!isUser && plan && <PlanChecklist plan={plan} />}
          {!isUser && goal && (
            <section className="chat-goal-card" aria-label={t('goal.title')} style={{
              padding: '10px 12px', border: '1px solid var(--border-soft)', borderRadius: 8,
              background: 'var(--surface)', fontSize: 'calc(12px * var(--font-scale))',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <strong>{t('goal.title')}</strong>
                <span>{t(`goal.status.${goal.status}` as Parameters<typeof t>[0])}</span>
              </div>
              {goal.objective && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{goal.objective}</div>}
              {goal.tokens_used !== undefined && (
                <div style={{ marginTop: 6, color: 'var(--meta)' }}>
                  {goal.tokens_used.toLocaleString()}{goal.token_budget ? ` / ${goal.token_budget.toLocaleString()}` : ''} tokens
                </div>
              )}
            </section>
          )}
          {!isUser && onInteractionRespond && interactions.map((item) => (
            <InteractionPrompt
              key={item.request.interaction_id}
              request={item.request}
              response={item.response}
              onRespond={onInteractionRespond}
            />
          ))}
          {!isUser && asyncQuestions.map((question, index) => (
            <div key={`${question.sourceItemId}-${index}`} className="chat-async-question">
              <div>{question.title}</div>
              {question.options.length > 0 && (
                <div className="chat-async-question-options">
                  {question.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="chat-message-action"
                      aria-pressed={asyncAnswers[index] === option}
                      disabled={asyncSubmitting || asyncSubmitted || (!onAsyncQuestionSubmit && !onSendToInput)}
                      onClick={() => {
                        const selected = { ...asyncAnswers, [index]: option }
                        setAsyncAnswers(selected)
                        const answer = asyncQuestions.flatMap((item, itemIndex) => (
                          selected[itemIndex]
                            ? [asyncQuestionAnswer(item, selected[itemIndex], asyncQuestions.length)]
                            : []
                        )).join('\n')
                        if (!onAsyncQuestionSubmit) {
                          onSendToInput?.(answer)
                        } else if (asyncQuestions.every((_, itemIndex) => selected[itemIndex])) {
                          setAsyncSubmitting(true)
                          setAsyncSubmitError('')
                          void onAsyncQuestionSubmit(answer).then((sent) => {
                            if (sent) setAsyncSubmitted(true)
                          }).catch((reason) => {
                            setAsyncSubmitError(reason instanceof Error ? reason.message : t('chatSession.sendFailed'))
                          }).finally(() => setAsyncSubmitting(false))
                        }
                      }}
                    >{option}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {asyncSubmitError && <div role="alert" style={{ color: 'var(--danger)' }}>{asyncSubmitError}</div>}
          {footer}
          {children}
        </div>
      </div>
      {isUser && previewImage && (
        <ImagePreview
          src={previewImage.src}
          alt={previewImage.alt}
          projectId={projectId}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  )
}
