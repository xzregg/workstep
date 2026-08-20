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
const GLOBAL_UPLOAD_RELATIVE = /^data\/uploads\/([^/?#]+)$/

function resolveUploadSrc(src: string | undefined, projectId?: string): string | undefined {
  if (!src) return src
  const projectMatch = src.match(UPLOAD_RELATIVE)
  if (projectMatch && projectId) {
    return `/api/fs/serve/${encodeURIComponent(projectMatch[1])}?project_id=${encodeURIComponent(projectId)}`
  }
  const globalMatch = src.match(GLOBAL_UPLOAD_RELATIVE)
  if (globalMatch) {
    return `/api/fs/serve/${encodeURIComponent(globalMatch[1])}`
  }
  return src
}

export default function MarkdownMessage({
  content,
  streaming = false,
  projectId,
}: MarkdownMessageProps) {
  const markdown = streaming ? closeStreamingFence(content) : content

  const components = {
    img: (props: { src?: string; alt?: string }) => (
      <img src={resolveUploadSrc(props.src, projectId)} alt={props.alt ?? ''} />
    ),
  }

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
