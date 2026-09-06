/**
 * Per-session pending insert queue persistence via localStorage.
 *
 * Key format: `workstep-chat-insert-queue:<projectId>:<sessionId>`
 * Only non-empty queues are stored; emptying the queue removes the key.
 * Entries carry their own id, so reordering and edits survive a page reload.
 */

import type { PendingMessageInsert } from '../components/PendingMessageInserts'

const PREFIX = 'workstep-chat-insert-queue'

function key(projectId: string, sessionId: string): string {
  return `${PREFIX}:${projectId}:${sessionId}`
}

export function saveInsertQueue(
  projectId: string,
  sessionId: string,
  items: PendingMessageInsert[],
): void {
  try {
    const k = key(projectId, sessionId)
    if (items.length > 0) {
      localStorage.setItem(k, JSON.stringify(items))
    } else {
      localStorage.removeItem(k)
    }
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

export function loadInsertQueue(
  projectId: string,
  sessionId: string,
): PendingMessageInsert[] {
  try {
    const raw = localStorage.getItem(key(projectId, sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PendingMessageInsert => (
      Boolean(item)
      && typeof item === 'object'
      && typeof item.id === 'string'
      && typeof item.content === 'string'
    ))
  } catch {
    return []
  }
}

export function clearInsertQueue(projectId: string, sessionId: string): void {
  try {
    localStorage.removeItem(key(projectId, sessionId))
  } catch {
    /* ignore */
  }
}
