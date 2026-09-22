/**
 * Per-session chat input draft persistence via localStorage.
 *
 * Key format: `workstep-chat-draft:<sessionId>`
 * Only non-empty drafts are stored; clearing sends removes the key.
 */

const PREFIX = 'workstep-chat-draft'

function key(sessionId: string): string {
  return `${PREFIX}:${sessionId}`
}

function legacyKey(projectId: string, sessionId: string): string {
  return `${PREFIX}:${projectId}:${sessionId}`
}

export function saveDraft(sessionId: string, text: string): void {
  try {
    const k = key(sessionId)
    if (text.trim()) {
      localStorage.setItem(k, text)
    } else {
      localStorage.removeItem(k)
    }
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

export function loadDraft(sessionId: string, legacyProjectId = ''): string {
  try {
    const current = localStorage.getItem(key(sessionId))
    if (current !== null) return current
    const legacy = legacyProjectId ? localStorage.getItem(legacyKey(legacyProjectId, sessionId)) : null
    if (legacy !== null) {
      localStorage.setItem(key(sessionId), legacy)
      localStorage.removeItem(legacyKey(legacyProjectId, sessionId))
      return legacy
    }
    return ''
  } catch {
    return ''
  }
}

export function clearDraft(sessionId: string, legacyProjectId = ''): void {
  try {
    localStorage.removeItem(key(sessionId))
    if (legacyProjectId) localStorage.removeItem(legacyKey(legacyProjectId, sessionId))
  } catch {
    /* ignore */
  }
}

const TASK_PREFIX = 'workstep-task-draft'

export function saveTaskDraft(taskId: string, text: string): void {
  try {
    const k = `${TASK_PREFIX}:${taskId}`
    if (text.trim()) localStorage.setItem(k, text)
    else localStorage.removeItem(k)
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

export function loadTaskDraft(taskId: string): string {
  try {
    return localStorage.getItem(`${TASK_PREFIX}:${taskId}`) ?? ''
  } catch {
    return ''
  }
}

export function clearTaskDraft(taskId: string): void {
  try {
    localStorage.removeItem(`${TASK_PREFIX}:${taskId}`)
  } catch {
    /* ignore */
  }
}
