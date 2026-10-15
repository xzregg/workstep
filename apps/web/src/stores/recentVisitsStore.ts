import { create } from 'zustand'
import { appearanceStorage } from '../utils/appearanceStorage'

export interface RecentVisitTarget {
  kind: 'session' | 'task'
  id: string
  projectId: string
  title: string
  workflowId?: string
}
export interface RecentVisit extends RecentVisitTarget { visitedAt: number }
const STORAGE_KEY = 'workstep.recent-visits.v1'
const LIMIT = 20
const sameTarget = (a: RecentVisitTarget, b: RecentVisitTarget) =>
  a.kind === b.kind && a.id === b.id && a.projectId === b.projectId

function read(): RecentVisit[] {
  try {
    const rows: unknown = JSON.parse(appearanceStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(rows)) return []
    return rows.filter((x): x is RecentVisit => x && (x.kind === 'session' || x.kind === 'task')
      && typeof x.id === 'string' && x.id && typeof x.projectId === 'string' && x.projectId
      && typeof x.title === 'string' && Number.isFinite(x.visitedAt)
      && (x.workflowId === undefined || typeof x.workflowId === 'string'))
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .filter((x, index, all) => all.findIndex(y => sameTarget(x, y)) === index).slice(0, LIMIT)
  } catch { return [] }
}

interface RecentVisitsState {
  entries: RecentVisit[]
  hydrate: () => void
  visit: (target: RecentVisitTarget) => void
  update: (target: RecentVisitTarget) => void
  removeSessions: (projectId: string, sessionIds: readonly string[]) => void
}

export const useRecentVisitsStore = create<RecentVisitsState>((set) => {
  const save = (entries: RecentVisit[]) => {
    appearanceStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    set({ entries })
  }
  return {
    entries: [],
    hydrate: () => set({ entries: read() }),
    removeSessions: (projectId, sessionIds) => {
      const removed = new Set(sessionIds)
      save(read().filter(entry => entry.kind !== 'session' || entry.projectId !== projectId || !removed.has(entry.id)))
    },
    visit: (target) => {
      const previous = read()
      // Strict ordering even when several clicks share the same millisecond.
      const visitedAt = Math.max(Date.now(), (previous[0]?.visitedAt || 0) + 1)
      save([{ ...target, visitedAt }, ...previous.filter(x => !sameTarget(x, target))].slice(0, LIMIT))
    },
    update: (target) => {
      const entries = read()
      const index = entries.findIndex(x => sameTarget(x, target))
      if (index < 0) return
      entries[index] = { ...target, visitedAt: entries[index].visitedAt }
      save(entries)
    },
  }
})

export function recentVisitPath(target: RecentVisitTarget, project: { name: string }): string {
  const params = new URLSearchParams({ project: project.name })
  if (target.kind === 'session') {
    params.set('session', target.id)
    return `/chat?${params}`
  }
  if (target.workflowId) params.set('workflow', target.workflowId)
  params.set('task', target.id)
  return `/tasks?${params}`
}
