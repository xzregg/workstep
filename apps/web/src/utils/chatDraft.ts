/**
 * Per-session chat input draft persistence via localStorage.
 *
 * Key format: `workstep-chat-draft:<projectId>:<sessionId>`
 * Only non-empty drafts are stored; clearing sends removes the key.
 */

const PREFIX = 'workstep-chat-draft'

function key(projectId: string, sessionId: string): string {
  return `${PREFIX}:${projectId}:${sessionId}`
}

export function saveDraft(projectId: string, sessionId: string, text: string): void {
  try {
    const k = key(projectId, sessionId)
    if (text.trim()) {
      localStorage.setItem(k, text)
    } else {
      localStorage.removeItem(k)
    }
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

export function loadDraft(projectId: string, sessionId: string): string {
  try {
    return localStorage.getItem(key(projectId, sessionId)) ?? ''
  } catch {
    return ''
  }
}

export function clearDraft(projectId: string, sessionId: string): void {
  try {
    localStorage.removeItem(key(projectId, sessionId))
  } catch {
    /* ignore */
  }
}
