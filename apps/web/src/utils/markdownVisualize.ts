const VISUALIZE_OPEN = '\ue200visualize'
const VISUALIZE_SEPARATOR = '\ue202'
const VISUALIZE_END = '\ue201'
const VISUALIZE_CORRUPTED_END = '\ufffd\ufffd'
const BARE_KEYWORD = 'visualize'

interface VisualizePayload {
  path?: unknown
}

function quoteFilePath(path: string): string {
  return encodeURIComponent(path)
    .replace(/%2F/gi, '/')
    .replace(/%3A/gi, ':')
}

function fileLink(path: string): string {
  const name = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1)
  if (!name) return ''
  let normalized = path.replace(/\\/g, '/')
  if (/^[a-z]:/i.test(normalized)) normalized = `/${normalized}`
  return `[${name}](file://${quoteFilePath(normalized)})`
}

function parsePayload(payload: string): VisualizePayload | null {
  try {
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as VisualizePayload
      : null
  } catch {
    return null
  }
}

function replacementFor(payload: string): string | null {
  const parsed = parsePayload(payload)
  return typeof parsed?.path === 'string' ? fileLink(parsed.path) || null : null
}

function jsonObjectEnd(text: string, start: number): number | null {
  if (text[start] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const end = index + 1
        return parsePayload(text.slice(start, end)) ? end : null
      }
    }
  }
  return null
}

function findTrailingBareMarker(text: string): { start: number; end: number } | null {
  let searchEnd = text.length
  while (true) {
    const start = text.lastIndexOf(BARE_KEYWORD, searchEnd - 1)
    if (start < 0) return null
    searchEnd = start
    if (start > 0 && text[start - 1] !== '\n') continue

    let cursor = start + BARE_KEYWORD.length
    if (text.startsWith(VISUALIZE_SEPARATOR, cursor)) {
      cursor += VISUALIZE_SEPARATOR.length
    }
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
    const end = jsonObjectEnd(text, cursor)
    if (end === null) continue

    const tail = text.slice(end).replace(/^[\n\r \t]+|[\n\r \t]+$/g, '')
    if (!tail) return { start, end }
    if ([...tail].every((char) => char === '\ufffd')) {
      return { start, end: text.length }
    }
  }
}

/**
 * Convert Codex's private ``visualize{JSON}`` marker into an ordinary Markdown
 * file link. The existing Markdown renderer then opens it with FilePreviewDialog
 * when a project id is available.
 */
export function convertVisualizeMarkers(text: string): string {
  const output: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf(VISUALIZE_OPEN, cursor)
    if (start < 0) {
      output.push(text.slice(cursor))
      break
    }

    let payloadStart = start + VISUALIZE_OPEN.length
    if (text.startsWith(VISUALIZE_SEPARATOR, payloadStart)) {
      payloadStart += VISUALIZE_SEPARATOR.length
    }
    while (text[payloadStart] === ' ' || text[payloadStart] === '\t') payloadStart += 1

    let payloadEnd = text.indexOf(VISUALIZE_END, payloadStart)
    let markerEnd = payloadEnd + VISUALIZE_END.length
    if (payloadEnd < 0) {
      payloadEnd = text.indexOf(VISUALIZE_CORRUPTED_END, payloadStart)
      markerEnd = payloadEnd + VISUALIZE_CORRUPTED_END.length
    }
    if (payloadEnd < 0) {
      output.push(text.slice(cursor))
      break
    }

    const rawMarker = text.slice(start, markerEnd)
    const payload = text.slice(payloadStart, payloadEnd)
    const replacement = replacementFor(payload)
    if (!replacement && payloadEnd >= 0 && text.indexOf(VISUALIZE_END, payloadStart) < 0) {
      output.push(text.slice(cursor))
      break
    }

    output.push(text.slice(cursor, start))
    output.push(replacement ?? rawMarker)
    cursor = markerEnd
  }

  const converted = output.join('')
  const bare = findTrailingBareMarker(converted)
  if (!bare) return converted
  const replacement = replacementFor(converted.slice(
    bare.start + BARE_KEYWORD.length,
    bare.end,
  ).replace(new RegExp(`^${VISUALIZE_SEPARATOR}`), '').trimStart())
  return replacement ? converted.slice(0, bare.start) + replacement : converted
}
