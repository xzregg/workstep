import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'

/** Measure rendered lines so explicit newlines and narrow-screen wrapping behave alike. */
export default function UserMessageContent({ content, children }: { content: string; children: ReactNode }) {
  const { t } = useI18n()
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expandedContent, setExpandedContent] = useState<string | null>(null)
  const expanded = expandedContent === content

  useLayoutEffect(() => {
    const element = body.current
    const inner = element?.firstElementChild
    if (!element || !inner) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
      setOverflowing(element.scrollHeight > lineHeight * 5 + 1)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(inner)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [content])

  return <div className="user-message-content">
    <div id={id} ref={body} className={`user-message-content-body${expanded ? '' : ' user-message-content-body--collapsed'}`}>
      {children}
    </div>
    {overflowing && <button type="button" className="user-message-content-toggle chat-message-action"
      aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpandedContent(expanded ? null : content)}>
      {t(expanded ? 'bubble.collapseMessage' : 'bubble.moreMessage')}
    </button>}
  </div>
}
