const OPEN = '<proposed_plan>'
const CLOSE = '</proposed_plan>'

/** Text-only fallback for engines that put the proposal envelope in the reply.
 * Ordinary messages return before any body scan; never parse Markdown here. */
export function proposedPlanText(text: string, streaming: boolean):
  { pending: true } | { content: string; complete: boolean; trailing: string } | undefined {
  const start = text.trimStart()
  if (!start.startsWith(OPEN)) {
    return streaming && start.length > 0 && OPEN.startsWith(start) ? { pending: true } : undefined
  }
  const body = start.slice(OPEN.length)
  const lastLine = body.slice(body.lastIndexOf('\n') + 1)
  const partialClose = streaming && lastLine.trim().length > 0 && CLOSE.startsWith(lastLine.trim())
  // Most live updates have no closing delimiter yet. Avoid scanning their lines.
  if (!body.includes(CLOSE) && !partialClose) return { content: body, complete: false, trailing: '' }
  let fence = '', fenceLength = 0
  for (const match of body.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)$|^ {0,3}<\/proposed_plan>[\t ]*\r?$/gm)) {
    if (match[1]) {
      const marker = match[1]
      if (!fence) {
        fence = marker[0]
        fenceLength = marker.length
      } else if (marker[0] === fence && marker.length >= fenceLength && !match[2].trim()) {
        fence = ''
      }
    } else if (!fence) {
      return { content: body.slice(0, match.index), complete: true, trailing: body.slice(match.index + match[0].length) }
    }
  }
  return {
    content: partialClose && !fence ? body.slice(0, body.length - lastLine.length) : body,
    complete: false, trailing: '',
  }
}
