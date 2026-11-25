import { createContext, isValidElement, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMarkdownBlocks } from '../utils/markdownBlocks'
import { isLocalMarkdownImage, resolveMarkdownImageSrc } from '../utils/markdownImages'
import { convertVisualizeMarkers } from '../utils/markdownVisualize'
import { convertFileCitations } from '../utils/markdownFileCitation'
import { classifyProjectFileLink, type ProjectFileLink } from '../utils/markdownFilePreview'
import { useI18n } from '../i18n'
import MermaidBlock, { MarkdownStreamingContext } from './MermaidBlock'
import { useMarkdownUrlResolver, useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'
import StreamRevealText from './StreamRevealText'
import WorkerMarkdownBlock from './WorkerMarkdownBlock'
import rehypeStreamReveal, { REVEAL_WINDOW_CHARS } from '../utils/rehypeStreamReveal'
import rehypeWebCitations, { incompleteWebCitationAtEnd } from '../utils/rehypeWebCitations'
import { parseTaskDetailLink } from '../utils/taskDetailLink'
import MarkdownTaskLink from './MarkdownTaskLink'

interface MarkdownContentProps {
  content: string
  streaming?: boolean
  projectId?: string
  className?: string
  compactParagraphs?: boolean
  plainText?: boolean
  /** Mermaid render delay; static content can pass 0 because it is already stable. */
  mermaidRenderDelayMs?: number
  onImageClick?: (button: HTMLButtonElement) => void
  onFileClick?: (file: ProjectFileLink) => void
  rootRef?: RefObject<HTMLDivElement | null>
  animateReveal?: boolean
  animateInitialReveal?: boolean
  freezeReveal?: boolean
}

const RevealContext = createContext({ enabled: false, animateInitial: true, from: 0 })
const revealPlugins = [rehypeStreamReveal]
const noRehypePlugins: [] = []

const MarkdownBlock = memo(function MarkdownBlock({ content, source, components, enabled, animateInitial, from, incompleteCitation, freezeReveal }: {
  content: string
  source: string
  components: ComponentProps<typeof ReactMarkdown>['components']
  enabled: boolean
  animateInitial: boolean
  from: number
  incompleteCitation?: string
  freezeReveal?: boolean
}) {
  const settings = useMemo(() => ({ enabled, animateInitial, from }), [enabled, animateInitial, from])
  const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = content.includes('\uE200')
    ? [[rehypeWebCitations, incompleteCitation], ...(enabled ? revealPlugins : noRehypePlugins)]
    : enabled ? revealPlugins : noRehypePlugins
  return <RevealContext.Provider value={settings}>
    {content.length >= 2048
      ? <WorkerMarkdownBlock content={content} source={source} incompleteCitation={incompleteCitation} components={components} urlTransform={fileAwareUrlTransform} paused={freezeReveal} />
      : <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components} urlTransform={fileAwareUrlTransform}>
        {content}
      </ReactMarkdown>}

  </RevealContext.Provider>
})

// Keep this component type stable as reveal settings change, so already
// displayed text keeps its state instead of replaying the whole paragraph.
function RevealText({ node }: { node?: { properties?: Record<string, unknown> } }) {
  const { enabled, animateInitial, from } = useContext(RevealContext)
  const text = String(node?.properties?.text ?? '')
  const end = Number(node?.properties?.endOffset ?? 0)
  // Markdown may remount a text node when a closing **, link or list marker
  // arrives. Its source position still tells us which text was already shown.
  const animateFrom = Math.max(0, text.length - Math.max(0, end - from))
  return <StreamRevealText text={text} enabled={enabled} animateInitial={animateInitial && node?.properties?.animate !== false} animateFrom={animateFrom} />
}

// Inline Markdown image / link tokens: `![alt](url)` and `[label](url)`.
// Group 1 is `!` for images, group 2 the alt/label, group 3 the URL target.
const MARKDOWN_INLINE = /(!?)\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

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
    const [, bang, rawLabel, url] = match
    const label = rawLabel.replace(/\\([\\[\]])/g, '$1')
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
const fileAwareUrlTransform: UrlTransform = (url, key) =>
  /^file:\/\//i.test(url) || (key === 'src' && isLocalMarkdownImage(url)) || parseTaskDetailLink(url) ? url : defaultUrlTransform(url)

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

function MarkdownContent({
  content,
  streaming = false,
  projectId,
  className,
  compactParagraphs = false,
  plainText = false,
  mermaidRenderDelayMs,
  onImageClick,
  onFileClick,
  rootRef,
  animateReveal = false,
  animateInitialReveal = true,
  freezeReveal = false,
}: MarkdownContentProps) {
  const { t } = useI18n()
  const markdownUrlResolver = useMarkdownUrlResolver()
  const taskFilePreview = useTaskFilePreview()
  // Structured results are literal data. Parsing their source-id arrays and
  // punctuation as GFM links/emphasis is expensive and changes string values.
  const structured = !plainText && /^\s*(?:<json>\s*)?(?:\{\s*"|\[\s*\{)/.test(content)
  const normalizedContent = structured
    ? content.replace(/^\s*<json>/, '').replace(/<\/json>\s*$/, '')
    : convertFileCitations(convertVisualizeMarkers(content))
  const [historyParser] = useState(() => !streaming && !animateReveal)
  const previousContent = useRef(animateInitialReveal ? '' : normalizedContent)
  const revealFrom = Math.max(
    normalizedContent.length - REVEAL_WINDOW_CHARS,
    normalizedContent.startsWith(previousContent.current) ? previousContent.current.length : normalizedContent.length,
  )
  useLayoutEffect(() => { previousContent.current = normalizedContent }, [normalizedContent])
  const markdown = !structured && streaming ? closeStreamingFence(normalizedContent) : normalizedContent
  const plainSegments = plainText ? splitPlainText(normalizedContent) : []

  const renderImage = useCallback((src: string | undefined, alt: string) => {
    if (!src) return null
    if (isLocalMarkdownImage(src) && !projectId) {
      return <span className="markdown-local-image">{alt && `${alt}：`}<code>{src}</code>（{t('md.localImageHint')}）</span>
    }
    const resolved = markdownUrlResolver?.(src) ?? resolveMarkdownImageSrc(src, projectId)
    if (!onImageClick) {
      return <img src={resolved} alt={alt} />
    }
    return (
      <button
        type="button"
        className="markdown-image-click"
        data-image-src={src}
        title={t('md.preview')}
        aria-label={`${t('md.preview')}：${alt || t('md.image')}`}
        onClick={event => onImageClick(event.currentTarget)}
      >
        <img src={resolved} alt={alt} />
      </button>
    )
  }, [markdownUrlResolver, onImageClick, projectId, t])

  const renderLink = useCallback((href: string | undefined, label: React.ReactNode, title?: string) => {
    const task = parseTaskDetailLink(href)
    if (task) {
      return task.projectId === projectId
        ? <MarkdownTaskLink key={href} target={task}>{label}</MarkdownTaskLink>
        : <span>{label}</span>
    }
    const resolvedHref = href && (markdownUrlResolver?.(href) ?? href)
    const file = classifyProjectFileLink(href, projectId || (taskFilePreview ? 'shared' : undefined))
    if (!file || !onFileClick) {
      return <a href={resolvedHref} title={title} target="_blank" rel="noopener noreferrer">{label}</a>
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
  }, [markdownUrlResolver, onFileClick, projectId, taskFilePreview, t])

  const components = useMemo(() => ({
    'stream-reveal-text': RevealText,
    p: ({ children }: { children?: React.ReactNode }) => compactParagraphs
      ? <div className="markdown-compact-paragraph">{children}</div>
      : <p>{children}</p>,
    img: (props: { src?: string; alt?: string }) => renderImage(props.src, props.alt ?? ''),
    a: (props: { href?: string; children?: React.ReactNode; title?: string }) =>
      renderLink(props.href, props.children, props.title),
    table: ({ children }: { children?: ReactNode }) => (
      <div className="markdown-table-scroll"><table>{children}</table></div>
    ),
    pre: ({ children }: { children?: ReactNode }) => {
      if (isValidElement<{ className?: string; children?: ReactNode }>(children)
        && /(?:^|\s)language-mermaid(?:\s|$)/i.test(children.props.className ?? '')) {
        const code = String(children.props.children ?? '').replace(/\n$/, '')
        return <MermaidBlock code={code} renderDelayMs={mermaidRenderDelayMs} />
      }
      return <pre>{children}</pre>
    },
  }), [compactParagraphs, mermaidRenderDelayMs, renderImage, renderLink])

  return (
    <MarkdownStreamingContext.Provider value={streaming}>
      <div
        ref={rootRef}
        className={`markdown-message${streaming ? ' is-streaming' : ''}${className ? ` ${className}` : ''}`}
        aria-live={streaming ? 'polite' : undefined}
      >
        {structured ? <p><StreamRevealText text={normalizedContent} enabled={animateReveal} animateInitial={animateInitialReveal} animateFrom={revealFrom} /></p> : plainText ? plainSegments.map((segment, index) => {
          if (segment.type === 'image') {
            return <span key={index} className="markdown-inline-image">{renderImage(segment.url, segment.alt)}</span>
          }
          if (segment.type === 'link') return <span key={index}>{renderLink(segment.url, segment.label)}</span>
          if (
            segment.text.trim() === ''
            && plainSegments[index - 1]?.type === 'image'
            && plainSegments[index + 1]?.type === 'image'
          ) return null
          return <span key={index}>{segment.text}</span>
        }) : (
          (historyParser && !streaming && markdown.length >= 2048
            ? [{ offset: 0, content: markdown }] : splitMarkdownBlocks(markdown)).map(block => <MarkdownBlock key={block.offset}
            content={block.content} source={normalizedContent.slice(block.offset, block.offset + block.content.length)} components={components} freezeReveal={freezeReveal} enabled={animateReveal && block.offset + block.content.length > revealFrom}
            incompleteCitation={(streaming || animateReveal) && block.offset + block.content.length === markdown.length
              ? incompleteWebCitationAtEnd(block.content) : undefined}
            animateInitial={animateReveal && block.offset + block.content.length > revealFrom && animateInitialReveal}
            from={animateReveal && block.offset + block.content.length > revealFrom ? Math.max(0, revealFrom - block.offset) : 0} />)
        )}
        {streaming && content.trim() !== '' && (
          <span className="markdown-stream-cursor" aria-hidden="true" />
        )}
      </div>
    </MarkdownStreamingContext.Provider>
  )
}

// Token arrivals can rerender the parent before the reveal timer advances.
// Parse only when the visible content or its rendering options change.
export default memo(MarkdownContent)
