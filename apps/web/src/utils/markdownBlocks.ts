export interface MarkdownBlock { offset: number; content: string }

/** Only seal independent blocks. Complex lists, quotes, HTML, indented code and
 * reference definitions can depend on surrounding blocks: keep their document
 * context intact. Fenced code can split before/after, never within the fence. */
export function splitMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split(/(?<=\n)/)
  const blocks: MarkdownBlock[] = []
  let offset = 0, start = 0, fence = '', inList = false
  const listItem = /^ {0,3}(?:[-+*]|\d+[.)])(?:\s|$)/
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (inList && !fence && /^\s+\S/.test(line)) return [{ offset: 0, content }]
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length
        && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = ''
    } else if (marker) {
      fence = marker
    } else if (/^(?: {0,3}>| {4}\S|\t| {0,3}\[[^\]\n]+\]:| {0,3}<)/.test(line)) {
      return [{ offset: 0, content }]
    } else if (listItem.test(line)) {
      inList = true
    }
    if (!fence && !marker) {
      let inline = ''
      for (const run of line.matchAll(/`+/g)) {
        if (!inline) inline = run[0]
        else if (inline === run[0]) inline = ''
      }
      if (inline) return [{ offset: 0, content }]
    }
    offset += line.length
    if (!fence && /^\s*\n$/.test(line) && !/^\s*\n$/.test(lines[index + 1] ?? '')
      && content.slice(start, offset).trim()) {
      // Blank lines between list items control tight/loose rendering. Keep
      // those items together, and only seal before an unindented new block.
      const next = lines[index + 1] ?? ''
      if (inList && (listItem.test(next) || /^\s+\S/.test(next))) continue
      blocks.push({ offset: start, content: content.slice(start, offset) })
      start = offset
      inList = false
    }
  }
  if (start < content.length || !blocks.length) blocks.push({ offset: start, content: content.slice(start) })
  return blocks
}
