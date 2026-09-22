export interface DiffLine { number: number; text: string; changed: boolean }
export interface DiffRow { before?: DiffLine; after?: DiffLine }
export interface DiffHunk { label: string; header: string; rows: DiffRow[] }
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
    if (match) { flush(); old = +match[1]; next = +match[2]; hunk = { label: match[3].trim() || line, header: line, rows: [] }; hunks.push(hunk); continue }
    if (!hunk) continue
    if (line.startsWith('-')) removed.push({ number: old++, text: line.slice(1), changed: true })
    else if (line.startsWith('+')) added.push({ number: next++, text: line.slice(1), changed: true })
    else if (line.startsWith(' ')) { flush(); hunk.rows.push({ before: { number: old++, text: line.slice(1), changed: false }, after: { number: next++, text: line.slice(1), changed: false } }) }
  }
  flush()
  return hunks
}
