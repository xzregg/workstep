import type { CSSProperties, MouseEvent } from 'react'
import Button from './Button'

const ALLOWED_TAGS = new Set(['A', 'B', 'BR', 'CODE', 'EM', 'I', 'SPAN', 'STRONG', 'U'])
const REMOVED_TAGS = new Set(['IFRAME', 'OBJECT', 'SCRIPT', 'STYLE', 'SVG', 'MATH'])

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Keep labels useful for formatting and links without allowing executable HTML. */
function sanitizeQuickPromptLabel(label: string): string {
  if (typeof document === 'undefined') return escapeHtml(label)

  const template = document.createElement('template')
  template.innerHTML = label
  const elements = [...template.content.querySelectorAll('*')]

  for (const element of elements) {
    if (REMOVED_TAGS.has(element.tagName)) {
      element.remove()
      continue
    }
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes)
      continue
    }

    for (const attribute of [...element.attributes]) {
      const allowed = attribute.name === 'title'
        || (element.tagName === 'A' && ['href', 'target', 'rel'].includes(attribute.name))
      if (!allowed) element.removeAttribute(attribute.name)
    }

    if (element.tagName === 'A') {
      const href = element.getAttribute('href') || ''
      let safeHref = false
      try {
        const url = new URL(href, window.location.href)
        safeHref = ['http:', 'https:', 'mailto:'].includes(url.protocol)
      } catch {
        safeHref = false
      }
      if (!safeHref) element.removeAttribute('href')
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
  }

  return template.innerHTML
}

interface QuickPromptButtonProps {
  label: string
  prompt: string
  disabled?: boolean
  displayOnly?: boolean
  displayContent?: string
  onSelect: (prompt: string) => void
  style?: CSSProperties
}

export default function QuickPromptButton({
  label,
  prompt,
  disabled = false,
  displayOnly = false,
  displayContent = '',
  onSelect,
  style,
}: QuickPromptButtonProps) {
  const containsHtml = /<[^>]+>/.test(label)
  const html = containsHtml ? sanitizeQuickPromptLabel(label) : ''
  const containsLink = containsHtml && /<a(?:\s|>)/i.test(html)
  const selectPrompt = () => {
    if (!disabled && prompt.trim()) onSelect(prompt)
  }

  if (displayOnly) {
    if (displayContent.trim()) {
      const contentHtml = sanitizeQuickPromptLabel(displayContent)
      return <span className="chat-quick-prompt-html" style={{ display: 'inline-flex', alignItems: 'center', ...style }}>
        <span dangerouslySetInnerHTML={{ __html: contentHtml }} />
      </span>
    }
    return <span className="chat-quick-prompt-html" style={style}>{containsHtml ? <span dangerouslySetInnerHTML={{ __html: html }} /> : label}</span>
  }

  if (!containsLink) {
    return (
      <Button
        type="button"
        size="sm"
        disabled={disabled || !prompt.trim()}
        onClick={selectPrompt}
        style={style}
      >
        {containsHtml
          ? <span dangerouslySetInnerHTML={{ __html: html }} />
          : label}
      </Button>
    )
  }

  return (
    <span
      className="btn btn-ghost btn-sm chat-quick-prompt-html"
      aria-disabled={disabled || undefined}
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        if ((event.target as Element).closest('a')) return
        selectPrompt()
      }}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
