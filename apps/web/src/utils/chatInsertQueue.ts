/**
 * Pending insert queue persistence via localStorage.
 *
 * Session queues use `workstep-chat-insert-queue:<sessionId>`.
 * Task queues use `workstep-task-insert-queue:<taskId>`.
 * Older project-scoped keys are read as a fallback and migrated on load.
 * Only non-empty queues are stored; emptying the queue removes the key.
 */

import type { PendingMessageInsert } from '../components/PendingMessageInserts'

const PREFIX = 'workstep-chat-insert-queue'
const TASK_PREFIX = 'workstep-task-insert-queue'

function key(sessionId: string): string {
  return `${PREFIX}:${sessionId}`
}

function legacyKey(projectId: string, sessionId: string): string {
  return `${PREFIX}:${projectId}:${sessionId}`
}

function taskKey(taskId: string): string {
  return `${TASK_PREFIX}:${taskId}`
}

function readItems(storageKey: string): PendingMessageInsert[] {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is PendingMessageInsert => (
    Boolean(item)
    && typeof item === 'object'
    && typeof item.id === 'string'
    && typeof item.content === 'string'
  ))
}

function writeItems(
  storageKey: string,
  items: PendingMessageInsert[],
): void {
  if (items.length > 0) {
    localStorage.setItem(storageKey, JSON.stringify(items))
  } else {
    localStorage.removeItem(storageKey)
  }
}

export function saveInsertQueue(
  sessionId: string,
  items: PendingMessageInsert[],
): void {
  try {
    writeItems(key(sessionId), items)
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

export function loadInsertQueue(
  sessionId: string,
  legacyProjectId = '',
): PendingMessageInsert[] {
  try {
    const currentKey = key(sessionId)
    if (localStorage.getItem(currentKey) !== null) {
      return readItems(currentKey)
    }
    if (!legacyProjectId) return []
    const oldKey = legacyKey(legacyProjectId, sessionId)
    const items = readItems(oldKey)
    if (items.length > 0) {
      writeItems(currentKey, items)
      localStorage.removeItem(oldKey)
    }
    return items
  } catch {
    return []
  }
}

export function clearInsertQueue(sessionId: string, legacyProjectId = ''): void {
  try {
    localStorage.removeItem(key(sessionId))
    if (legacyProjectId) {
      localStorage.removeItem(legacyKey(legacyProjectId, sessionId))
    }
  } catch {
    /* ignore */
  }
}

export function saveTaskInsertQueue(
  taskId: string,
  items: PendingMessageInsert[],
): void {
  try {
    writeItems(taskKey(taskId), items)
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

export function loadTaskInsertQueue(
  taskId: string,
  legacyProjectId = '',
): PendingMessageInsert[] {
  try {
    const currentKey = taskKey(taskId)
    if (localStorage.getItem(currentKey) !== null) {
      return readItems(currentKey)
    }
    if (!legacyProjectId) return []
    const oldKey = legacyKey(legacyProjectId, taskId)
    const items = readItems(oldKey)
    if (items.length > 0) {
      writeItems(currentKey, items)
      localStorage.removeItem(oldKey)
    }
    return items
  } catch {
    return []
  }
}

export function clearTaskInsertQueue(taskId: string, legacyProjectId = ''): void {
  try {
    localStorage.removeItem(taskKey(taskId))
    if (legacyProjectId) {
      localStorage.removeItem(legacyKey(legacyProjectId, taskId))
    }
  } catch {
    /* ignore */
  }
}
