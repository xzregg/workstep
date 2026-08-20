import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import type { A2uiClientAction } from '@a2ui/web_core/v0_9'
import A2uiMessage from './A2uiMessage'
import MessageTimeline from './MessageTimeline'
import { MessageCopyButton } from './MessageResponseFooter'
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
import { latestPlanFromEvents } from '../utils/plan'

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
  /** Bubble background: 'surface' (default) or 'bg' (+ border). */
  variant?: 'surface' | 'bg'
  /** Extra props for the root element (ref / data attributes). */
  rootProps?: ChatMessageRootProps
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
  badge,
  header,
  footer,
  children,
  showLoading = false,
  loading,
  onEdit,
  onA2uiAction,
  events = [],
  a2uiMessages,
  onInteractionRespond,
  variant = 'surface',
  rootProps,
}: ChatMessageBubbleProps) {
  const { t } = useI18n()
  const isUser = role === 'user'
  const interactions = pendingInteractionItems(events)
  const plan = latestPlanFromEvents(events)
  const hasToolActivity = !isUser && events.some((event) => (
    event.type === 'tool_use' || event.type === 'tool_result'
    || isToolEvent(event)
  ))
  if (isUser && isHiddenA2uiActionMessage(content)) return null
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
    <div {...rootProps} style={rootStyle} className="chat-message-row">
      {isUser && header && (
        <div style={{
          fontSize: 11, color: 'var(--meta)', textAlign: 'right',
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
        <div
          title={senderTitle || sender}
          aria-label={sender}
          style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            background: color, color: 'var(--accent-fg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 600, position: 'relative',
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
              fontSize: 11, fontWeight: 800, lineHeight: 1,
            }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{
          flex: isUser ? '0 1 auto' : 1,
          minWidth: 0, display: 'flex',
          flexDirection: 'column', gap: 6,
          alignItems: isUser ? 'flex-end' : 'stretch',
        }}>
          {!isUser && header && (
            // 元信息栏放在头像右侧、消息上方。
            <div style={{ width: '100%' }}>
              {header}
            </div>
          )}
          {(content || hasToolActivity) ? (
            <div style={{
              fontSize: 13, lineHeight: 1.6,
              color: isUser ? 'var(--fg)' : 'var(--fg-2)',
              background: isUser ? 'var(--surface)' : 'var(--bg)',
              border: !isUser && variant === 'bg' ? '1px solid var(--border-soft)' : 'none',
              padding: '10px 14px', borderRadius: 12,
              borderBottomRightRadius: isUser ? 4 : 12,
              borderBottomLeftRadius: isUser ? 12 : 4,
              width: isUser ? 'fit-content' : undefined,
              minWidth: 0, maxWidth: '100%', overflow: 'hidden',
            }}>
              {isUser ? (
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content}</div>
              ) : (
                <>
                  <MessageTimeline
                    content={stripAssistantPayloadsForDisplay(content)}
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
            !isUser && showLoading && streaming && interactions.length === 0 && !plan && (
              loading ?? (
                <div className="engine-loading-message" role="status" aria-live="polite">
                  <span>{t('bubble.thinking')}</span>
                  <span className="engine-loading-dots" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                </div>
              )
            )
          )}
          {isUser && content && (
            // 预留固定高度的操作行，hover 时显示复制/编辑，不撑开下方布局。
            <div style={{
              display: 'flex', justifyContent: 'flex-end',
              alignItems: 'center', gap: 2, minHeight: 24,
            }}>
              {onEdit && (
                <button
                  type="button"
                  className="chat-message-action"
                  title={t('bubble.editMessage')}
                  aria-label={t('bubble.editMessage')}
                  onClick={() => onEdit(content)}
                  style={{
                    width: 24, height: 24, minWidth: 24, padding: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'transparent', border: 'none', borderRadius: 6,
                    color: 'var(--muted)', cursor: 'pointer',
                  }}
                >
                  <Icon name="pencil" size={12} strokeWidth={2} />
                </button>
              )}
              <MessageCopyButton content={content} className="chat-message-action" />
            </div>
          )}
          {!isUser && error && (
            <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 4 }}>{error}</div>
          )}
          {!isUser && plan && <PlanChecklist plan={plan} />}
          {!isUser && onInteractionRespond && interactions.map((item) => (
            <InteractionPrompt
              key={item.request.interaction_id}
              request={item.request}
              response={item.response}
              onRespond={onInteractionRespond}
            />
          ))}
          {footer}
          {children}
        </div>
      </div>
    </div>
  )
}
