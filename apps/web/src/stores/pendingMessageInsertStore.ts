import { create } from 'zustand'

import {
  pendingMessageInsertApi,
  type PendingMessageInsertItem,
} from '../api/client'

function queueKey(projectId: string, targetMessageId: string): string {
  return `${projectId}:${targetMessageId}`
}

interface PendingMessageInsertState {
  queues: Record<string, PendingMessageInsertItem[]>
  loaded: Record<string, boolean>
  loading: Record<string, boolean>
  load: (projectId: string, targetMessageId: string) => Promise<void>
  add: (projectId: string, targetMessageId: string, content: string) => Promise<void>
  update: (projectId: string, targetMessageId: string, id: string, content: string) => Promise<void>
  remove: (projectId: string, targetMessageId: string, id: string) => Promise<void>
  clear: (projectId: string, targetMessageId: string) => Promise<void>
  reorder: (projectId: string, targetMessageId: string, fromIndex: number, toIndex: number) => Promise<void>
  discard: (projectId: string, targetMessageId: string, ids: string[]) => void
  invalidate: (projectId: string, targetMessageId: string) => void
}

export const usePendingMessageInsertStore = create<PendingMessageInsertState>((set, get) => ({
  queues: {},
  loaded: {},
  loading: {},

  load: async (projectId, targetMessageId) => {
    if (!projectId || !targetMessageId) return
    const key = queueKey(projectId, targetMessageId)
    const state = get()
    if (state.loaded[key] || state.loading[key]) return
    set((current) => ({ loading: { ...current.loading, [key]: true } }))
    try {
      const result = await pendingMessageInsertApi.list(projectId, targetMessageId)
      set((current) => ({
        queues: { ...current.queues, [key]: result.items },
        loaded: { ...current.loaded, [key]: true },
      }))
    } finally {
      set((current) => ({ loading: { ...current.loading, [key]: false } }))
    }
  },

  add: async (projectId, targetMessageId, content) => {
    const item = await pendingMessageInsertApi.create(projectId, targetMessageId, content)
    const key = queueKey(projectId, targetMessageId)
    set((current) => ({
      queues: { ...current.queues, [key]: [...(current.queues[key] || []), item] },
      loaded: { ...current.loaded, [key]: true },
    }))
  },

  update: async (projectId, targetMessageId, id, content) => {
    const item = await pendingMessageInsertApi.update(projectId, id, content)
    const key = queueKey(projectId, targetMessageId)
    set((current) => ({
      queues: {
        ...current.queues,
        [key]: (current.queues[key] || []).map((entry) => entry.id === id ? item : entry),
      },
    }))
  },

  remove: async (projectId, targetMessageId, id) => {
    await pendingMessageInsertApi.remove(projectId, id)
    const key = queueKey(projectId, targetMessageId)
    set((current) => ({
      queues: {
        ...current.queues,
        [key]: (current.queues[key] || []).filter((entry) => entry.id !== id),
      },
    }))
  },

  clear: async (projectId, targetMessageId) => {
    await pendingMessageInsertApi.clear(projectId, targetMessageId)
    const key = queueKey(projectId, targetMessageId)
    set((current) => ({ queues: { ...current.queues, [key]: [] } }))
  },

  reorder: async (projectId, targetMessageId, fromIndex, toIndex) => {
    const key = queueKey(projectId, targetMessageId)
    const currentItems = get().queues[key] || []
    if (
      fromIndex < 0 || fromIndex >= currentItems.length
      || toIndex < 0 || toIndex >= currentItems.length
      || fromIndex === toIndex
    ) return
    const optimistic = [...currentItems]
    const [moved] = optimistic.splice(fromIndex, 1)
    optimistic.splice(toIndex, 0, moved)
    set((current) => ({ queues: { ...current.queues, [key]: optimistic } }))
    try {
      const result = await pendingMessageInsertApi.reorder(
        projectId,
        targetMessageId,
        optimistic.map((item) => item.id),
      )
      set((current) => ({ queues: { ...current.queues, [key]: result.items } }))
    } catch (error) {
      set((current) => ({ queues: { ...current.queues, [key]: currentItems } }))
      throw error
    }
  },

  discard: (projectId, targetMessageId, ids) => {
    const key = queueKey(projectId, targetMessageId)
    const consumed = new Set(ids)
    set((current) => ({
      queues: {
        ...current.queues,
        [key]: (current.queues[key] || []).filter((entry) => !consumed.has(entry.id)),
      },
    }))
  },

  invalidate: (projectId, targetMessageId) => {
    const key = queueKey(projectId, targetMessageId)
    set((current) => {
      const loaded = { ...current.loaded }
      delete loaded[key]
      return { loaded }
    })
  },
}))

export function pendingInsertQueueKey(projectId: string, targetMessageId: string): string {
  return queueKey(projectId, targetMessageId)
}
