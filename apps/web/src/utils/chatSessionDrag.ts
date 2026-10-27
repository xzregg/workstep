/** Separate session drags from files, text, workflow and project reordering. */
export const CHAT_SESSION_DRAG_TYPE = 'application/x-workstep-chat-session'

export function writeChatSessionDrag(transfer: DataTransfer, projectId: string, sessionId: string) {
  transfer.effectAllowed = 'copyMove'
  transfer.setData('text/plain', sessionId)
  transfer.setData(CHAT_SESSION_DRAG_TYPE, JSON.stringify({ projectId, sessionId }))
}

export function readChatSessionDrag(transfer: DataTransfer): { projectId: string; sessionId: string } | null {
  try {
    const value = JSON.parse(transfer.getData(CHAT_SESSION_DRAG_TYPE))
    return typeof value?.projectId === 'string' && typeof value?.sessionId === 'string'
      && value.projectId && value.sessionId ? { projectId: value.projectId, sessionId: value.sessionId } : null
  } catch {
    return null
  }
}
