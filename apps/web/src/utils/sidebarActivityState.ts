export const SIDEBAR_ACTIVITY_STATE_KEY = 'workstep.sidebar.activity-read.v1'

/**
 * Cap per map. Acknowledged ids mostly accumulate (a marker is dropped when its
 * failure resolves), so the oldest entries are evicted first to keep the payload
 * bounded; evicting one can only make an old dot reappear, never hide a new one.
 */
const MAX_ENTRIES = 300

type SidebarStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface SidebarActivityReadState {
  readFailedWorkflows: Record<string, true>
  readFailedSessions: Record<string, true>
  readFailedProjects: Record<string, true>
}

export const EMPTY_READ_STATE: SidebarActivityReadState = {
  readFailedWorkflows: {},
  readFailedSessions: {},
  readFailedProjects: {},
}

function browserStorage(): SidebarStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function trueMap(value: unknown): Record<string, true> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, marker]) => marker === true)
      .map(([id]) => [id, true as const]),
  )
}

/** Keep only the newest entries; object key order is insertion order. */
function capped(map: Record<string, true>): Record<string, true> {
  const entries = Object.entries(map)
  if (entries.length <= MAX_ENTRIES) return map
  return Object.fromEntries(entries.slice(entries.length - MAX_ENTRIES))
}

/**
 * Read markers must survive a reload: sidebar failure state is re-derived from
 * backend snapshots (`workflow.failed`, `last_message_status`) on every load, so
 * an in-memory-only acknowledgement lights the same dot up again after refresh.
 */
export function loadSidebarActivityReadState(
  storage: SidebarStorage | null = browserStorage(),
): SidebarActivityReadState {
  if (!storage) return { ...EMPTY_READ_STATE }
  try {
    const parsed = JSON.parse(storage.getItem(SIDEBAR_ACTIVITY_STATE_KEY) || 'null')
    return {
      readFailedWorkflows: trueMap(parsed?.readFailedWorkflows),
      readFailedSessions: trueMap(parsed?.readFailedSessions),
      readFailedProjects: trueMap(parsed?.readFailedProjects),
    }
  } catch {
    return { ...EMPTY_READ_STATE }
  }
}

export function saveSidebarActivityReadState(
  state: SidebarActivityReadState,
  storage: SidebarStorage | null = browserStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_ACTIVITY_STATE_KEY, JSON.stringify({
      readFailedWorkflows: capped(state.readFailedWorkflows),
      readFailedSessions: capped(state.readFailedSessions),
      readFailedProjects: capped(state.readFailedProjects),
    }))
  } catch {
    // Acknowledgements are a convenience; never break the sidebar over storage.
  }
}
