import { useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { resolveMarkdownImageSrc } from '../utils/markdownImages'
import { classifyProjectFileLink, type ProjectFileLink } from '../utils/markdownFilePreview'
import { useI18n } from '../i18n'
import FilePreviewDialog from './FilePreviewDialog'

interface MarkdownMessageProps {
  content: string
  streaming?: boolean
  /** Project id used to resolve `.workstep/uploads/...` relative image paths. */
  projectId?: string
  className?: string
  /** Render paragraphs as compact blocks for nested process/event timelines. */
  compactParagraphs?: boolean
  /** When set, images render as clickable thumbnails calling this with (src, alt). */
  onImageClick?: (src: string, alt: string) => void
}

/**
 * ReactMarkdown's default URL transform strips any scheme outside its
 * allow-list (http/https/irc/mailto/...), turning `file://` links into empty
 * hrefs before the custom `a` component ever sees them. Preserve `file://`
 * so `MarkdownMessage` can resolve it as a previewable project file; defer
 * every other URL to the default (sanitising) transform.
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

export default function MarkdownMessage({
  content,
  streaming = false,
  projectId,
  className,
  compactParagraphs = false,
  onImageClick,
}: MarkdownMessageProps) {
  const { t } = useI18n()
  const [previewFile, setPreviewFile] = useState<ProjectFileLink | null>(null)
  const markdown = streaming ? closeStreamingFence(content) : content

  const components = {
    p: ({ children }: { children?: React.ReactNode }) => compactParagraphs
      ? <div className="markdown-compact-paragraph">{children}</div>
      : <p>{children}</p>,
    img: (props: { src?: string; alt?: string }) => {
      const alt = props.alt ?? ''
      if (!props.src) return null
      const resolved = resolveMarkdownImageSrc(props.src, projectId)
      if (!onImageClick) {
        return <img src={resolved} alt={alt} />
      }
      return (
        <button
          type="button"
          className="markdown-image-click"
          title={t('md.preview')}
          aria-label={`${t('md.preview')}：${alt || t('md.image')}`}
          onClick={() => onImageClick(props.src as string, alt)}
        >
          <img src={resolved} alt={alt} />
        </button>
      )
    },
    a: (props: { href?: string; children?: React.ReactNode; title?: string }) => {
      const file = classifyProjectFileLink(props.href, projectId)
      if (!file) {
        return <a href={props.href} title={props.title}>{props.children}</a>
      }
      return (
        <a
          href={props.href}
          title={t('md.previewFile', { name: file.name })}
          aria-label={t('md.previewFile', { name: file.name })}
          className="markdown-file-link"
          data-file-preview="true"
          onClick={(event) => {
            event.preventDefault()
            setPreviewFile(file)
          }}
        >
          {props.children}
        </a>
      )
    },
  }

  return (
    <>
      <div
        className={`markdown-message${streaming ? ' is-streaming' : ''}${className ? ` ${className}` : ''}`}
        aria-live={streaming ? 'polite' : undefined}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={fileAwareUrlTransform}>
          {markdown}
        </ReactMarkdown>
        {streaming && <span className="markdown-stream-cursor" aria-hidden="true" />}
      </div>
      {previewFile && projectId && (
        <FilePreviewDialog
          path={previewFile.path}
          name={previewFile.name}
          line={previewFile.line}
          projectId={projectId}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </>
  )
}
