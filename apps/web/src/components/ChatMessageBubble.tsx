import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react'
import MarkdownMessage from './MarkdownMessage'

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
  /** Bubble background: 'surface' (default) or 'bg' (+ border). */
  variant?: 'surface' | 'bg'
  /** Extra props for the root element (ref / data attributes). */
  rootProps?: ChatMessageRootProps
}

export default function ChatMessageBubble({
  role,
  sender,
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
  variant = 'surface',
  rootProps,
}: ChatMessageBubbleProps) {
  const isUser = role === 'user'
  const rootStyle: CSSProperties = {
    width: isUser ? 'fit-content' : '85%',
    maxWidth: '85%', minWidth: 0,
    display: 'flex', flexDirection: 'column', gap: 4,
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    ...(rootProps?.style || {}),
  }
  return (
    <div {...rootProps} style={rootStyle}>
      {isUser && header && (
        <div style={{
          fontSize: 10, color: 'var(--meta)', textAlign: 'right', paddingRight: 44,
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
      }}>
        <div
          title={sender}
          aria-label={sender}
          style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            background: color, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 600, position: 'relative',
          }}
        >
          {initials}
          {badge && (
            <span style={{
              position: 'absolute', right: -4, bottom: -4,
              width: 16, height: 16, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#7c3aed', color: '#fff',
              border: '2px solid var(--bg)',
              fontSize: 9, fontWeight: 800, lineHeight: 1,
            }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{
          flex: isUser ? '0 1 auto' : 1,
          minWidth: 0, display: 'flex',
          flexDirection: 'column', gap: 6,
        }}>
          {!isUser && header}
          {content ? (
            <div style={{
              fontSize: 13, lineHeight: 1.6,
              color: isUser ? '#fff' : 'var(--fg-2)',
              background: isUser ? 'var(--accent)' : (variant === 'bg' ? 'var(--bg)' : 'var(--surface)'),
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
                <MarkdownMessage content={content} streaming={streaming} projectId={projectId} />
              )}
            </div>
          ) : (
            !isUser && showLoading && streaming && (
              loading ?? (
                <div className="engine-loading-message" role="status" aria-live="polite">
                  <span>思考中…</span>
                  <span className="engine-loading-dots" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                </div>
              )
            )
          )}
          {!isUser && error && (
            <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{error}</div>
          )}
          {footer}
          {children}
        </div>
      </div>
    </div>
  )
}
