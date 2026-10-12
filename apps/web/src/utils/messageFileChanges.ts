import { isToolEvent, toolCallId } from './agui'
import type { MessageTimelineEvent, MessageTimelineItem, ToolActivity } from './messageTimeline'
import { extractToolTarget, toolKind } from './toolInput'

export interface MessageFileChange {
  path: string
  /** 累计编辑行数；没有可靠来源时不显示统计。 */
  added: number | null
  removed: number | null
  /** 本轮各次编辑的补丁快照，不能替换为当前工作区 diff。 */
  patch?: string
}

/** 展示用相对路径；原始路径继续用于文件预览和历史差异。 */
export function relativeMessageFilePath(path: string, projectRoot?: string): string {
  const source = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  const root = projectRoot?.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = /^(\/|[a-z]:\/)/i
  if (!root || !absolute.test(source) || !absolute.test(root)) return source
  const windows = /^[a-z]:\//i.test(source)
  const compare = (value: string) => windows ? value.toLowerCase() : value
  const sourceParts = source.split('/').filter(Boolean)
  const rootParts = root.split('/').filter(Boolean)
  if (windows !== /^[a-z]:\//i.test(root)
    || (windows && compare(sourceParts[0]) !== compare(rootParts[0]))) return source
  let common = 0
  while (common < rootParts.length && common < sourceParts.length
    && compare(rootParts[common]) === compare(sourceParts[common])) common++
  return [...rootParts.slice(common).map(() => '..'), ...sourceParts.slice(common)].join('/') || '.'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function lineCount(text: string): number {
  return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
}

function changeFromRecord(value: unknown): MessageFileChange | null {
  if (typeof value === 'string') return { path: value, added: null, removed: null }
  const data = record(value)
  if (!data) return null
  const path = extractToolTarget(data).fileTarget
  if (!path) return null
  const patch = typeof data.diff === 'string' ? data.diff : typeof data.patch === 'string' ? data.patch : ''
  // 只统计 hunk 中的 +/-，避免把文件头或输出正文算成改动。
  if (/^@@ -\d+/m.test(patch)) {
    let added = 0, removed = 0, inHunk = false
    for (const line of patch.split('\n')) {
      if (line.startsWith('@@ ')) inHunk = true
      else if (line.startsWith('diff ')) inHunk = false
      else if (inHunk && line.startsWith('+')) added++
      else if (inHunk && line.startsWith('-')) removed++
    }
    return { path, added, removed, patch }
  }
  const before = data.oldText !== undefined ? data.oldText
    : data.old_text !== undefined ? data.old_text : data.old_string
  const after = data.newText ?? data.new_text ?? data.new_string
  if ((typeof before === 'string' || before === null) && typeof after === 'string'
    && !data.replace_all) {
    return { path, added: lineCount(after), removed: lineCount(before ?? '') }
  }
  return { path, added: null, removed: null }
}

function patchChanges(patch: string): MessageFileChange[] {
  const changes: MessageFileChange[] = []
  let current: MessageFileChange | undefined
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line)
    if (header) {
      current = { path: header[2], added: header[1] === 'Delete' ? null : 0,
        removed: header[1] === 'Delete' ? null : 0 }
      changes.push(current)
    } else if (current && line.startsWith('*** Move to: ')) {
      current.path = line.slice('*** Move to: '.length)
    } else if (line.startsWith('*** ')) {
      if (line === '*** End Patch') current = undefined
    } else if (current && current.added !== null && current.removed !== null) {
      if (line.startsWith('+')) current.added++
      else if (line.startsWith('-')) current.removed++
    }
  }
  return changes
}

function toolChanges(activity: ToolActivity, content: unknown): MessageFileChange[] {
  const args = extractToolTarget(activity.input).record
  const diffContent = Array.isArray(content)
    ? content.flatMap(value => {
      const data = record(value)
      return data?.type === 'diff' ? [data] : []
    }) : []
  // ACP diff 内容比普通工具入参更完整；Codex changes 不能仅取提升的首个 path。
  const candidates = diffContent.length ? diffContent
    : Array.isArray(args?.changes) ? args.changes
      : Array.isArray(activity.result) ? activity.result : args ? [args] : []
  const changes = candidates.flatMap(value => {
    const change = changeFromRecord(value)
    return change ? [change] : []
  })
  if (changes.length) return changes
  const patch = typeof activity.input === 'string' && activity.input.includes('*** Begin Patch')
    ? activity.input : args?.patch ?? args?.input
  return typeof patch === 'string' ? patchChanges(patch) : []
}

export function collectMessageFileChanges(
  timeline: MessageTimelineItem[],
  events: MessageTimelineEvent[] = [],
  projectRoot?: string,
): MessageFileChange[] {
  const contents = new Map<string, unknown>()
  for (const event of events) {
    if (isToolEvent(event) && Array.isArray(event.content)) {
      contents.set(toolCallId(event), event.content)
    }
  }
  const files = new Map<string, MessageFileChange>()
  for (const item of timeline) {
    const activities = item.type === 'tool' ? [item.activity]
      : item.type === 'tool-group' ? item.activities : []
    for (const activity of activities) {
      if (!activity.hasResult || activity.isError || toolKind(activity.name, activity.kind) !== 'edit') continue
      for (const change of toolChanges(activity, contents.get(activity.id))) {
        const path = change.path.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
        if (!path) continue
        const key = relativeMessageFilePath(path, projectRoot)
        const previous = files.get(key)
        if (!previous) files.set(key, { ...change, path })
        else {
          previous.added = previous.added !== null && change.added !== null ? previous.added + change.added : null
          previous.removed = previous.removed !== null && change.removed !== null ? previous.removed + change.removed : null
          // 仅在所有编辑都有补丁时提供完整的历史差异。
          previous.patch = previous.patch && change.patch ? `${previous.patch}\n${change.patch}` : undefined
        }
      }
    }
  }
  return [...files.values()]
}
