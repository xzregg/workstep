export const SIDEBAR_SECTION_STATE_KEY = 'workstep.sidebar.expanded-sections.v1'

type SidebarStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface SidebarSectionState {
  expandedProjectIds: string[]
  flowsByProject: Record<string, boolean>
  conversationsByProject: Record<string, boolean>
}

const EMPTY_STATE: SidebarSectionState = {
  expandedProjectIds: [],
  flowsByProject: {},
  conversationsByProject: {},
}

function browserStorage(): SidebarStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function booleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  )
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function loadSidebarSectionState(
  storage: Pick<SidebarStorage, 'getItem'> | null = browserStorage(),
): SidebarSectionState {
  if (!storage) return EMPTY_STATE
  try {
    const parsed = JSON.parse(storage.getItem(SIDEBAR_SECTION_STATE_KEY) || 'null')
    const expandedProjectIds = Array.isArray(parsed?.expandedProjectIds)
      ? stringArray(parsed.expandedProjectIds)
      : typeof parsed?.expandedProjectId === 'string'
        ? [parsed.expandedProjectId]
        : []
    return {
      expandedProjectIds,
      flowsByProject: booleanMap(parsed?.flowsByProject),
      conversationsByProject: booleanMap(parsed?.conversationsByProject),
    }
  } catch {
    return EMPTY_STATE
  }
}

export function saveSidebarSectionState(
  state: SidebarSectionState,
  storage: Pick<SidebarStorage, 'setItem'> | null = browserStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_SECTION_STATE_KEY, JSON.stringify(state))
  } catch {
    // Keep section toggles usable when browser storage is unavailable or full.
  }
}
