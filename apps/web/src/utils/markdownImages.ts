export interface MarkdownTextSegment {
  type: 'text'
  markdown: string
  start: number
  end: number
}

export interface MarkdownImageSegment {
  type: 'image'
  markdown: string
  alt: string
  url: string
  start: number
  end: number
}

export type MarkdownInputSegment = MarkdownTextSegment | MarkdownImageSegment

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const UPLOAD_RELATIVE = /^(?:[^/]+\/)?\.workstep\/uploads\/([^/?#]+)$/
const GLOBAL_UPLOAD_RELATIVE = /^data\/uploads\/([^/?#]+)$/

export function splitMarkdownImages(markdown: string): MarkdownInputSegment[] {
  const segments: MarkdownInputSegment[] = []
  let cursor = 0

  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) {
    const start = match.index
    if (start > cursor) {
      segments.push({
        type: 'text',
        markdown: markdown.slice(cursor, start),
        start: cursor,
        end: start,
      })
    }
    const imageMarkdown = match[0]
    segments.push({
      type: 'image',
      markdown: imageMarkdown,
      alt: match[1],
      url: match[2],
      start,
      end: start + imageMarkdown.length,
    })
    cursor = start + imageMarkdown.length
  }

  segments.push({
    type: 'text',
    markdown: markdown.slice(cursor),
    start: cursor,
    end: markdown.length,
  })
  return segments
}

export function removeMarkdownImage(markdown: string, image: MarkdownImageSegment): string {
  const before = markdown.slice(0, image.start)
  let after = markdown.slice(image.end)
  if (before.endsWith('\n\n') && after.startsWith('\n\n')) after = after.slice(2)
  else if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1)
  return before + after
}

export function resolveMarkdownImageSrc(src: string, projectId?: string): string {
  const projectMatch = src.match(UPLOAD_RELATIVE)
  if (projectMatch && projectId) {
    return `/api/fs/serve/${encodeURIComponent(projectMatch[1])}?project_id=${encodeURIComponent(projectId)}`
  }
  const globalMatch = src.match(GLOBAL_UPLOAD_RELATIVE)
  if (globalMatch) return `/api/fs/serve/${encodeURIComponent(globalMatch[1])}`
  return src
}
