import type { AssistantChatEvent, AssistantChatMessage } from '../../stores/assistantStore'
import { isCommentaryEvent } from '../../utils/agui'
import { speechText, takeSpeechSentences } from '../../utils/speechOutput'

function shortSentence(text: string, complete: boolean) {
  const { sentences: [first] } = takeSpeechSentences(speechText(text, complete).trim(), complete)
  return { first, short: first && first.length <= 48 ? first : undefined }
}

export function newCommentarySentences(
  events: AssistantChatMessage['events'],
  handled = new Set<string | AssistantChatEvent>(),
) {
  const sentences: string[] = []
  let item: AssistantChatEvent | undefined
  let text = ''
  const flush = (complete: boolean) => {
    if (!item) return
    const key = item.source_item_id || item
    if (!handled.has(key)) {
      const { first, short } = shortSentence(text, complete)
      if (first || complete) handled.add(key)
      if (short) sentences.push(short)
    }
    item = undefined
    text = ''
  }
  for (const event of events ?? []) {
    if (event.previewOnly) continue
    if (isCommentaryEvent(event) && (!event.role || event.role === 'assistant')) {
      if (item && item.source_item_id !== event.source_item_id) flush(true)
      item ??= event
      const update = event.content ?? event.delta ?? ''
      text = event.type === 'TEXT_MESSAGE_CONTENT' ? update : text + update
    } else if (event.type === 'TOOL_CALL_START') {
      flush(true)
    } else if (event.type === 'TEXT_MESSAGE_CHUNK' && event.role !== 'user' && event.delta?.trim()) {
      break
    }
  }
  flush(false)
  return sentences
}

export function recordedCommentary(message: AssistantChatMessage) {
  if (message.role !== 'assistant') return []
  const preview = message.event_summary?.commentary_preview
  if (preview && message.status !== 'running' && !message.event_detail?.loaded) {
    return preview.flatMap(({ text, complete }) => shortSentence(text, complete).short ?? [])
  }
  const live = newCommentarySentences(message.events)
  return live.length ? live : (preview ?? []).flatMap(({ text, complete }) => shortSentence(text, complete).short ?? [])
}
