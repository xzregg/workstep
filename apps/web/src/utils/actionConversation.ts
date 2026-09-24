/** Merge persisted and newly started Action runs into the conversation timeline. */
export interface ActionRunLike {
  user_message_id: string
  reply_message_id: string
  title: string
  output: string
  status: string
  started_at: string
}

export function mergeActionMessages<
  T extends { id: string; content: string; created_at?: string },
  R extends ActionRunLike,
>(
  messages: T[],
  runs: R[],
  isAction: (message: T) => boolean,
  create: (run: R, role: 'user' | 'assistant') => T,
): Array<T & { actionRun?: R }> {
  const byId = new Map<string, R>()
  for (const run of runs) {
    byId.set(run.user_message_id, run)
    byId.set(run.reply_message_id, run)
  }
  const seen = new Set(messages.map((message) => message.id))
  const merged: Array<T & { actionRun?: R }> = messages.map((message) => {
    const run = isAction(message) ? byId.get(message.id) : undefined
    return run
      ? { ...message, content: message.id === run.reply_message_id ? run.output : message.content, actionRun: run }
      : message
  })
  for (const run of runs) {
    for (const role of ['user', 'assistant'] as const) {
      const id = role === 'user' ? run.user_message_id : run.reply_message_id
      if (seen.has(id)) continue
      seen.add(id)
      merged.push({ ...create(run, role), actionRun: run })
    }
  }
  return merged.sort((left, right) => {
    const delta = Date.parse(left.created_at || '') - Date.parse(right.created_at || '')
    if (Number.isFinite(delta) && delta !== 0) return delta
    const leftRun = byId.get(left.id)
    if (leftRun?.user_message_id === left.id && right.id === leftRun.reply_message_id) return -1
    const rightRun = byId.get(right.id)
    if (rightRun?.user_message_id === right.id && left.id === rightRun.reply_message_id) return 1
    return 0
  })
}
