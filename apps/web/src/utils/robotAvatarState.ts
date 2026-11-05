import type { EventLike } from './agui'
import { pendingInteractionItems } from './interaction'

export type RobotAvatarState = 'connecting' | 'thinking' | 'searching' | 'working' | 'writing' | 'waiting' | 'done' | 'failed' | 'stopped'
export type MessageTerminalStatus = 'failed' | 'stopped' | 'cancelled'
type AvatarEvent = EventLike & { kind?: string }

export const isRobotActive = (state: RobotAvatarState) => (
  state === 'connecting' || state === 'thinking' || state === 'searching' || state === 'working' || state === 'writing'
)

function terminalState(status?: string): RobotAvatarState | undefined {
  if (status === 'cancelled' || status === 'stopped') return 'stopped'
  if (status === 'failed' || status === 'error') return 'failed'
}

/** Presentation only: use the same AG-UI events as the message, including in read-only shares. */
export function resolveRobotAvatarState({ streaming, status, error, content = '', events = [], awaitingAnswer = false }: {
  streaming: boolean
  status?: MessageTerminalStatus
  error?: string
  content?: string
  events?: AvatarEvent[]
  awaitingAnswer?: boolean
}): RobotAvatarState {
  const terminal = terminalState(status)
  if (terminal) return terminal
  if (!streaming && error) return 'failed'
  // A restarted run supersedes errors/finish events from its previous attempt.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'RUN_STARTED') break
    if (event.type === 'RUN_ERROR') return 'failed'
    if (event.type === 'RUN_FINISHED') return terminalState(event.status) || 'done'
  }
  if (!streaming) return 'done'
  if (awaitingAnswer || pendingInteractionItems(events).length > 0) return 'waiting'

  const finished = new Set<string>()
  let activity: RobotAvatarState | undefined
  let activeTool: RobotAvatarState | undefined
  let hasToolUpdate = false
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'RUN_STARTED') break
    const id = event.toolCallId || ''
    // TOOL_CALL_END ends argument streaming, not execution. Only a result or
    // explicit terminal tool status closes the call; parallel calls remain busy.
    if (event.type === 'TOOL_CALL_RESULT' || (event.type?.startsWith('TOOL_CALL_') && ['completed', 'failed'].includes(event.status || ''))) {
      finished.add(id)
      activity ??= 'thinking'
    } else if (event.type === 'TOOL_CALL_START' && !finished.has(id) && !activeTool) {
      const name = (event.toolCallName || event.name || '').toLowerCase().split(/[./:]/).at(-1) || ''
      activeTool = ['read', 'search', 'fetch'].includes(event.kind || '')
        || /^(read|read_file|read_text_file|search|web_search|web_fetch|fetch|grep|glob|list_directory)$/.test(name)
        ? 'searching' : 'working'
    } else if (event.type === 'TOOL_CALL_CHUNK' && !finished.has(id)) {
      hasToolUpdate = true
    }
    if (event.type?.startsWith('REASONING_')) activity ??= 'thinking'
    if (['TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CHUNK'].includes(event.type || '') && (event.delta || event.content)) activity ??= 'writing'
  }
  return activeTool || (hasToolUpdate ? 'working' : activity) || (content ? 'writing' : 'connecting')
}
