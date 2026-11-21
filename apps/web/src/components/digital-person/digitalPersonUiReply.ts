import type { AssistantChatMessage } from '../../stores/assistantStore'

export type DigitalPersonUiAction =
  | { action: 'conversation.open'; title: string; project?: string }
  | { action: 'conversation.open'; project_id: string; session_id: string }
  | { action: 'window.close' }

const marker = '```workstep-ui'
const openingFence = /^ {0,3}```workstep-ui[ \t]*(?:\r?\n|$)/gm
const closingFence = /^ {0,3}```[ \t]*(?:\r?\n|$)/gm

function parseAction(json: string): DigitalPersonUiAction | undefined {
  if (json.length > 1024) return
  try {
    const value = JSON.parse(json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const keys = Object.keys(value)
    if (value.action === 'window.close' && keys.length === 1) return { action: value.action }
    if (value.action !== 'conversation.open') return
    if (keys.includes('project_id') || keys.includes('session_id')) {
      if (keys.length !== 3 || typeof value.project_id !== 'string' || typeof value.session_id !== 'string') return
      const project_id = value.project_id.trim()
      const session_id = value.session_id.trim()
      if (project_id && session_id) return { action: value.action, project_id, session_id }
      return
    }
    if (!keys.every(key => ['action', 'title', 'project'].includes(key))) return
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    const project = typeof value.project === 'string' ? value.project.trim() : ''
    if (!title || (keys.includes('project') && !project)) return
    return { action: value.action, title, ...(project ? { project } : {}) }
  } catch {
    return
  }
}

export function readDigitalPersonUiReply(content: string, streaming = false): { text: string; action?: DigitalPersonUiAction } {
  let visible = ''
  let first = true
  while (true) {
    const start = content.includes(marker) ? content.matchAll(openingFence).next().value : undefined
    if (!start) {
      if (streaming) {
        const lastLine = content.lastIndexOf('\n') + 1
        const tail = content.slice(lastLine).trimStart()
        if (tail && marker.startsWith(tail)) content = content.slice(0, lastLine)
      }
      return { text: visible + content }
    }
    visible += content.slice(0, start.index)
    const body = start.index + start[0].length
    const close = content.slice(body).matchAll(closingFence).next().value
    if (!close) return { text: visible }
    const after = content.slice(body + close.index + close[0].length)
    if (first && !visible.trim() && !after.trim()) {
      const action = streaming ? undefined : parseAction(content.slice(body, body + close.index))
      return action ? { text: '', action } : { text: '' }
    }
    first = false
    content = after
  }
}

const visibleMessages = new WeakMap<AssistantChatMessage, AssistantChatMessage>()

export function visibleDigitalPersonMessages(messages: AssistantChatMessage[]) {
  return messages.map(message => {
    if (message.role !== 'assistant') return message
    const previous = visibleMessages.get(message)
    if (previous) return previous
    const { text } = readDigitalPersonUiReply(message.content, message.status === 'running')
    const visible = text === message.content ? message : { ...message, content: text }
    visibleMessages.set(message, visible)
    return visible
  })
}
