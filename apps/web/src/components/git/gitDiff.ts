export interface DiffLine { number: number; text: string; changed: boolean }
export interface DiffRow { before?: DiffLine; after?: DiffLine }
export interface DiffHunk { label: string; header: string; beforeStart: number; afterStart: number; rows: DiffRow[] }
export interface DiffBlock { start: number; end: number }

export function changedBlocks(hunk: DiffHunk): DiffBlock[] {
  const blocks: DiffBlock[] = []
  hunk.rows.forEach((row, index) => {
    if (row.before?.changed || row.after?.changed) {
      if (blocks.at(-1)?.end === index) blocks[blocks.length - 1].end++
      else blocks.push({ start: index, end: index + 1 })
    }
  })
  return blocks
}

export function restoreDiffBlock(content: string, hunk: DiffHunk, block: DiffBlock, beforeContent?: string): string | null {
  const rows = hunk.rows.slice(block.start, block.end)
  const afterLines = rows.flatMap(row => row.after ? [row.after] : [])
  const beforeLines = rows.flatMap(row => row.before ? [row.before.text] : [])
  const previous = hunk.rows.slice(0, block.start).findLast(row => row.after)?.after
  const next = hunk.rows.slice(block.end).find(row => row.after)?.after
  const start = Math.max(0, afterLines[0] ? afterLines[0].number - 1 : previous ? previous.number : hunk.afterStart - 1)
  const lines = content ? content.split('\n') : []
  const touchesEnd = start + afterLines.length >= lines.length - (content.endsWith('\n') ? 1 : 0)
  if ((previous && lines[previous.number - 1] !== previous.text) || (next && lines[next.number - 1] !== next.text)) return null
  if (lines.slice(start, start + afterLines.length).some((line, index) => line !== afterLines[index].text)) return null
  lines.splice(start, afterLines.length, ...beforeLines)
  let result = lines.join('\n')
  if (touchesEnd && beforeContent !== undefined) {
    if (beforeContent.endsWith('\n') && result && !result.endsWith('\n')) result += '\n'
    else if (!beforeContent.endsWith('\n') && result.endsWith('\n')) result = result.slice(0, -1)
  }
  return result
}

export function expandHunks(before: string, after: string, hunks: DiffHunk[]): DiffHunk {
  const beforeLines = before ? before.split('\n').slice(0, before.endsWith('\n') ? -1 : undefined) : []
  const afterLines = after ? after.split('\n').slice(0, after.endsWith('\n') ? -1 : undefined) : []
  const rows: DiffRow[] = []
  let old = 1, next = 1
  const appendContext = (oldEnd: number, nextEnd: number) => {
    while (old < oldEnd && next < nextEnd) {
      rows.push({ before: { number: old, text: beforeLines[old - 1], changed: false }, after: { number: next, text: afterLines[next - 1], changed: false } })
      old++; next++
    }
  }
  for (const hunk of hunks) {
    appendContext(hunk.beforeStart, hunk.afterStart)
    rows.push(...hunk.rows)
    for (const row of hunk.rows) {
      if (row.before) old = row.before.number + 1
      if (row.after) next = row.after.number + 1
    }
  }
  appendContext(beforeLines.length + 1, afterLines.length + 1)
  return { label: '', header: '', beforeStart: 1, afterStart: 1, rows }
}
export function parseGitPatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let hunk: DiffHunk | undefined
  let old = 0, next = 0
  let removed: DiffLine[] = [], added: DiffLine[] = []
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) hunk?.rows.push({ before: removed[i], after: added[i] })
    removed = []; added = []
  }
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (match) { flush(); old = +match[1]; next = +match[2]; hunk = { label: match[3].trim() || line, header: line, beforeStart: old, afterStart: next, rows: [] }; hunks.push(hunk); continue }
    if (!hunk) continue
    if (line.startsWith('-')) removed.push({ number: old++, text: line.slice(1), changed: true })
    else if (line.startsWith('+')) added.push({ number: next++, text: line.slice(1), changed: true })
    else if (line.startsWith(' ')) { flush(); hunk.rows.push({ before: { number: old++, text: line.slice(1), changed: false }, after: { number: next++, text: line.slice(1), changed: false } }) }
  }
  flush()
  return hunks
}
