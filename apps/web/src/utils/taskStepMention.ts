export interface TaskStepMentionQuery {
  start: number
  query: string
}

export function taskStepMentionQuery(
  value: string,
  cursor: number,
): TaskStepMentionQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length))
  const beforeCursor = value.slice(0, safeCursor)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/u)
  if (!match) return null
  return {
    start: safeCursor - match[2].length - 1,
    query: match[2],
  }
}

export function applyTaskStepMention(
  value: string,
  cursor: number,
): { value: string; cursor: number } {
  const mention = taskStepMentionQuery(value, cursor)
  if (!mention) return { value, cursor }
  return {
    value: value.slice(0, mention.start) + value.slice(cursor),
    cursor: mention.start,
  }
}
