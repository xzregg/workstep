import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownMessageProps {
  content: string
  streaming?: boolean
  /** Project id used to resolve `.workstep/uploads/...` relative image paths. */
  projectId?: string
}

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

const UPLOAD_RELATIVE = /^[^/]+\.workstep\/uploads\/([^/?#]+)$/

export default function MarkdownMessage({
  content,
  streaming = false,
  projectId,
}: MarkdownMessageProps) {
  const markdown = streaming ? closeStreamingFence(content) : content

  const components = projectId
    ? {
        img: (props: { src?: string; alt?: string }) => {
          const match = props.src?.match(UPLOAD_RELATIVE)
          const src = match
            ? `/api/fs/serve/${encodeURIComponent(match[1])}?project_id=${encodeURIComponent(projectId)}`
            : props.src
          return <img src={src} alt={props.alt ?? ''} />
        },
      }
    : undefined

  return (
    <div
      className={`markdown-message${streaming ? ' is-streaming' : ''}`}
      aria-live={streaming ? 'polite' : undefined}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
      {streaming && <span className="markdown-stream-cursor" aria-hidden="true" />}
    </div>
  )
}
