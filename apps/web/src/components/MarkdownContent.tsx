import { isValidElement, useCallback, useMemo, type ReactNode, type RefObject } from 'react'
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { resolveMarkdownImageSrc } from '../utils/markdownImages'
import { convertVisualizeMarkers } from '../utils/markdownVisualize'
import { classifyProjectFileLink, type ProjectFileLink } from '../utils/markdownFilePreview'
import { useI18n } from '../i18n'
import MermaidBlock, { MarkdownStreamingContext } from './MermaidBlock'
import { useMarkdownUrlResolver } from '../contexts/MarkdownAssetUrlContext'

interface MarkdownContentProps {
  content: string
  streaming?: boolean
  projectId?: string
  className?: string
  compactParagraphs?: boolean
  plainText?: boolean
  onImageClick?: (src: string, alt: string) => void
  onFileClick?: (file: ProjectFileLink) => void
  rootRef?: RefObject<HTMLDivElement | null>
}

// Inline Markdown image / link tokens: `![alt](url)` and `[label](url)`.
// Group 1 is `!` for images, group 2 the alt/label, group 3 the URL target.
const MARKDOWN_INLINE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

type PlainSegment =
  | { type: 'text'; text: string }
  | { type: 'image'; alt: string; url: string }
  | { type: 'link'; label: string; url: string }

function splitPlainText(markdown: string): PlainSegment[] {
  const segments: PlainSegment[] = []
  let cursor = 0
  for (const match of markdown.matchAll(MARKDOWN_INLINE)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ type: 'text', text: markdown.slice(cursor, start) })
    const [, bang, label, url] = match
    if (bang) segments.push({ type: 'image', alt: label, url })
    else segments.push({ type: 'link', label, url })
    cursor = start + match[0].length
  }
  if (cursor < markdown.length) segments.push({ type: 'text', text: markdown.slice(cursor) })
  return segments
}

/**
 * ReactMarkdown's default URL transform strips any scheme outside its
 * allow-list (http/https/irc/mailto/...), turning `file://` links into empty
 * hrefs before the custom `a` component ever sees them. Preserve `file://`
 * so project file links can stay previewable.
 */
const fileAwareUrlTransform: UrlTransform = (url) =>
  /^file:\/\//i.test(url) ? url : defaultUrlTransform(url)

function closeStreamingFence(markdown: string): string {
  let openFence = ''
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (!match) continue
    const marker = match[1][0]
    if (!openFence) {
      openFence = marker.repeat(match[1].length)
    } else if (openFence[0] === marker) {
      openFence = ''
    }
  }
  return openFence ? `${markdown}\n${openFence}` : markdown
}

export default function MarkdownContent({
  content,
  streaming = false,
  projectId,
  className,
  compactParagraphs = false,
  plainText = false,
  onImageClick,
  onFileClick,
  rootRef,
}: MarkdownContentProps) {
  const { t } = useI18n()
  const markdownUrlResolver = useMarkdownUrlResolver()
  const normalizedContent = convertVisualizeMarkers(content)
  const markdown = streaming ? closeStreamingFence(normalizedContent) : normalizedContent

  const renderImage = useCallback((src: string | undefined, alt: string) => {
    if (!src) return null
    const resolved = markdownUrlResolver?.(src) ?? resolveMarkdownImageSrc(src, projectId)
    if (!onImageClick) {
      return <img src={resolved} alt={alt} />
    }
    return (
      <button
        type="button"
        className="markdown-image-click"
        title={t('md.preview')}
        aria-label={`${t('md.preview')}：${alt || t('md.image')}`}
        onClick={() => onImageClick(src, alt)}
      >
        <img src={resolved} alt={alt} />
      </button>
    )
  }, [markdownUrlResolver, onImageClick, projectId, t])

  const renderLink = useCallback((href: string | undefined, label: React.ReactNode, title?: string) => {
    const resolvedHref = href && (markdownUrlResolver?.(href) ?? href)
    const file = classifyProjectFileLink(href, projectId)
    if (!file || !onFileClick) {
      return <a href={resolvedHref} title={title}>{label}</a>
    }
    return (
      <a
        href={href}
        title={t('md.previewFile', { name: file.name })}
        aria-label={t('md.previewFile', { name: file.name })}
        className="markdown-file-link"
        data-file-preview="true"
        onClick={(event) => {
          event.preventDefault()
          onFileClick(file)
        }}
      >
        {label}
      </a>
    )
  }, [markdownUrlResolver, onFileClick, projectId, t])

  const components = useMemo(() => ({
    p: ({ children }: { children?: React.ReactNode }) => compactParagraphs
      ? <div className="markdown-compact-paragraph">{children}</div>
      : <p>{children}</p>,
    img: (props: { src?: string; alt?: string }) => renderImage(props.src, props.alt ?? ''),
    a: (props: { href?: string; children?: React.ReactNode; title?: string }) =>
      renderLink(props.href, props.children, props.title),
    pre: ({ children }: { children?: ReactNode }) => {
      if (isValidElement<{ className?: string; children?: ReactNode }>(children)
        && /(?:^|\s)language-mermaid(?:\s|$)/i.test(children.props.className ?? '')) {
        const code = String(children.props.children ?? '').replace(/\n$/, '')
        return <MermaidBlock code={code} />
      }
      return <pre>{children}</pre>
    },
  }), [compactParagraphs, renderImage, renderLink])

  return (
    <MarkdownStreamingContext.Provider value={streaming}>
      <div
        ref={rootRef}
        className={`markdown-message${streaming ? ' is-streaming' : ''}${className ? ` ${className}` : ''}`}
        aria-live={streaming ? 'polite' : undefined}
      >
        {plainText ? splitPlainText(normalizedContent).map((segment, index) => {
          if (segment.type === 'image') return <span key={index}>{renderImage(segment.url, segment.alt)}</span>
          if (segment.type === 'link') return <span key={index}>{renderLink(segment.url, segment.label)}</span>
          return <span key={index}>{segment.text}</span>
        }) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={fileAwareUrlTransform}>
            {markdown}
          </ReactMarkdown>
        )}
        {streaming && content.trim() !== '' && (
          <span className="markdown-stream-cursor" aria-hidden="true" />
        )}
      </div>
    </MarkdownStreamingContext.Provider>
  )
}
