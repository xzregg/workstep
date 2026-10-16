import { create } from 'zustand'
import { taskApi } from '../api/client'
import { CUSTOM, isCustom, isRunEvent, type AGUIEvent } from '../utils/agui'
import type { RecentVisitTarget } from './recentVisitsStore'

export const recentActivityKey = (target: Pick<RecentVisitTarget, 'projectId' | 'id'>) =>
  JSON.stringify([target.projectId, target.id])

type Target = Pick<RecentVisitTarget, 'kind' | 'projectId' | 'id'>
interface RecentActivityState {
  targets: Target[]
  runningTasks: Record<string, boolean>
  failedTasks: Record<string, boolean>
  completedTasks: Record<string, true>
  readFailedTasks: Record<string, true>
  markTaskRead: (target: Pick<Target, 'projectId' | 'id'>) => void
  setTargets: (targets: Target[]) => void
  refreshTasks: () => Promise<void>
  handleWsEvent: (event: AGUIEvent) => Promise<void>
}

// Requests belong to a target object: removed targets and old authentication
// scopes cannot publish a late response into a new subscription.
export const useRecentActivityStore = create<RecentActivityState>((set, get) => {
  const pending = new Map<Target, Promise<void>>()
  const dirty = new Set<Target>()
  const refresh = (target: Target, invalidate = false): Promise<void> => {
    const existing = pending.get(target)
    if (existing) {
      if (invalidate) dirty.add(target)
      return existing
    }
    const request = (async () => {
      do {
        dirty.delete(target)
        let running = false
        let failed = false
        let readable = false
        try {
          const task = await taskApi.get(target.id, target.projectId)
          readable = true
          running = task.status === 'running'
          failed = task.status === 'failed' || Boolean(task.steps?.some(step => step.status === 'failed'))
        } catch { /* Unknown or unreadable state must not keep a spinner lit. */ }
        if (!get().targets.includes(target)) break
        // An event during the read invalidates that snapshot; read again before
        // publishing so a slow request cannot undo the latest transition.
        if (!dirty.has(target)) set(state => {
          const key = recentActivityKey(target)
          const completedTasks = { ...state.completedTasks }
          const readFailedTasks = { ...state.readFailedTasks }
          const finished = readable && !running && state.runningTasks[key] === true
          if (running || !failed || finished) delete readFailedTasks[key]
          if (running || !readable) delete completedTasks[key]
          else if (finished) completedTasks[key] = true
          return {
            runningTasks: { ...state.runningTasks, [key]: running },
            failedTasks: { ...state.failedTasks, [key]: failed && !readFailedTasks[key] },
            completedTasks,
            readFailedTasks,
          }
        })
      } while (dirty.has(target) && get().targets.includes(target))
    })().finally(() => { pending.delete(target); dirty.delete(target) })
    pending.set(target, request)
    return request
  }
  return {
    targets: [],
    runningTasks: {},
    failedTasks: {},
    completedTasks: {},
    readFailedTasks: {},
    markTaskRead: (target) => set(state => {
      const key = recentActivityKey(target)
      const completedTasks = { ...state.completedTasks }
      delete completedTasks[key]
      return {
        completedTasks,
        failedTasks: { ...state.failedTasks, [key]: false },
        readFailedTasks: { ...state.readFailedTasks, [key]: true },
      }
    }),
    setTargets: (targets) => {
      const previous = get().targets
      const next = targets.map(target => previous.find(item =>
        item.kind === target.kind && item.id === target.id && item.projectId === target.projectId,
      ) || target)
      if (next.length === previous.length && next.every((item, i) => item === previous[i])) return
      const keys = new Set(next.filter(item => item.kind === 'task').map(recentActivityKey))
      const retain = <T,>(values: Record<string, T>) => Object.fromEntries(
        Object.entries(values).filter(([key]) => keys.has(key)),
      )
      set(state => ({
        targets: next,
        runningTasks: retain(state.runningTasks),
        failedTasks: retain(state.failedTasks),
        completedTasks: retain(state.completedTasks),
        readFailedTasks: retain(state.readFailedTasks),
      }))
      for (const target of next) {
        if (target.kind === 'task' && !previous.includes(target)) void refresh(target)
      }
    },
    refreshTasks: async () => {
      await Promise.all(get().targets.filter(target => target.kind === 'task').map(target => refresh(target, true)))
    },
    handleWsEvent: async (event) => {
      if (!event.task_id || !(isRunEvent(event) || isCustom(event, CUSTOM.status)
        || isCustom(event, CUSTOM.stepRetrying) || isCustom(event, CUSTOM.runRecovered)
        || isCustom(event, CUSTOM.taskUpdated))) return
      await Promise.all(get().targets.filter(target => target.kind === 'task'
        && target.id === event.task_id && (!event.project_id || target.projectId === event.project_id),
      ).map(target => refresh(target, true)))
    },
  }
})
