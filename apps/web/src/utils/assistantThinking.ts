interface ConversationMessageLike {
  channel?: string
  role?: string
  status?: string
  run_status?: string
}

export function shouldShowAssistantThinking(
  running: boolean,
  messages: readonly ConversationMessageLike[],
  channel?: string,
): boolean {
  if (!running) return false
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user'
      && (!channel || messages[index]?.channel === channel)) {
      lastUserIndex = index
      break
    }
  }
  return !messages.some((message, index) => (
    index > lastUserIndex
    && message.role === 'assistant'
    && (!channel || message.channel === channel)
  ))
}
