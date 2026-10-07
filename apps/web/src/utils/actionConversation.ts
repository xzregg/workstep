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
  // Insert only missing Action rows. The store/history already owns the order
  // of ordinary messages, including optimistic sends with a different clock.
  for (const run of [...runs].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))) {
    for (const role of ['user', 'assistant'] as const) {
      const id = role === 'user' ? run.user_message_id : run.reply_message_id
      if (seen.has(id)) continue
      seen.add(id)
      const message = { ...create(run, role), actionRun: run }
      const counterpart = merged.findIndex((existing) => existing.id === (
        role === 'user' ? run.reply_message_id : run.user_message_id
      ))
      let index = counterpart < 0 ? merged.findIndex((existing) => (
        Date.parse(existing.created_at || '') > Date.parse(run.started_at)
      )) : counterpart + (role === 'assistant' ? 1 : 0)
      if (index < 0) index = merged.length
      merged.splice(index, 0, message)
    }
  }
  return merged
}
