import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownMessageProps {
  content: string
  streaming?: boolean
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

export default function MarkdownMessage({
  content,
  streaming = false,
}: MarkdownMessageProps) {
  const markdown = streaming ? closeStreamingFence(content) : content

  return (
    <div
      className={`markdown-message${streaming ? ' is-streaming' : ''}`}
      aria-live={streaming ? 'polite' : undefined}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
      {streaming && <span className="markdown-stream-cursor" aria-hidden="true" />}
    </div>
  )
}
