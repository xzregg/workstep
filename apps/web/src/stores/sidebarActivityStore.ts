import { create } from 'zustand'
import {
  loadSidebarActivityReadState,
  saveSidebarActivityReadState,
} from '../utils/sidebarActivityState'

export function deriveWorkflowRunningState(
  projects: Array<{ id: string; workflows?: Array<{ id: string; running?: boolean }> }>,
  tasks: Array<{ workflow_id?: string | null; status?: string }>,
  activeProjectId?: string,
): Record<string, boolean> {
  return Object.fromEntries(projects.flatMap((project) => (
    (project.workflows || []).map((workflow) => {
      const workflowTasks = project.id === activeProjectId
        ? tasks.filter((task) => task.workflow_id === workflow.id)
        : []
      return [
        workflow.id,
        workflowTasks.length > 0
          ? workflowTasks.some((task) => task.status === 'running')
          : Boolean(workflow.running),
      ]
    })
  )))
}

export function deriveWorkflowFailedState(
  projects: Array<{ id: string; workflows?: Array<{ id: string; failed?: boolean }> }>,
  tasks: Array<{ workflow_id?: string | null; steps?: Array<{ status?: string }> }>,
  activeProjectId?: string,
): Record<string, boolean> {
  return Object.fromEntries(projects.flatMap((project) => (
    (project.workflows || []).map((workflow) => {
      const workflowTasks = project.id === activeProjectId
        ? tasks.filter((task) => task.workflow_id === workflow.id)
        : []
      return [
        workflow.id,
        workflowTasks.length > 0
          ? workflowTasks.some((task) => (
              task.steps?.some((step) => step.status === 'failed')
            ))
          : Boolean(workflow.failed),
      ]
    })
  )))
}

export function deriveSessionFailedState(
  sessions: Array<{ id: string; last_message_status?: string | null }>,
  liveSessions: Record<string, { messages?: Array<{ status?: string }> }>,
): Record<string, boolean> {
  const failed = Object.fromEntries(sessions.map((session) => [
    session.id,
    session.last_message_status === 'error' || session.last_message_status === 'failed',
  ]))
  for (const [sessionId, session] of Object.entries(liveSessions)) {
    const last = session.messages?.at(-1)
    if (last) failed[sessionId] = last.status === 'error' || last.status === 'failed'
  }
  return failed
}

/**
 * Same derivation as {@link deriveSessionFailedState}, but fed by a
 * per-session last-message-status map so callers can subscribe to a
 * shallow-stable slice of the live store instead of the whole session
 * objects (which change reference on every streamed token).
 */
export function deriveSessionFailedStateFromLastStatus(
  sessions: Array<{ id: string; last_message_status?: string | null }>,
  lastStatusById: Record<string, string | null>,
): Record<string, boolean> {
  const failed = Object.fromEntries(sessions.map((session) => [
    session.id,
    session.last_message_status === 'error' || session.last_message_status === 'failed',
  ]))
  for (const [sessionId, status] of Object.entries(lastStatusById)) {
    // A live session with no messages yet must not override the persisted state.
    if (status) failed[sessionId] = status === 'error' || status === 'failed'
  }
  return failed
}

interface SidebarActivityState {
  completedWorkflows: Record<string, string>
  completedSessions: Record<string, true>
  readFailedWorkflows: Record<string, true>
  readFailedSessions: Record<string, true>
  /**
   * Projects the user has opened since their last failure. Suppresses the project
   * roll-up dot even for children that load later (a collapsed project's chat
   * sessions are only fetched once the project becomes active).
   */
  readFailedProjects: Record<string, true>
  markWorkflowCompleted: (projectId: string, workflowId: string) => void
  markWorkflowRead: (workflowId: string) => void
  markWorkflowStarted: (workflowId: string) => void
  markProjectRead: (projectId: string, workflowIds?: string[], sessionIds?: string[]) => void
  markProjectUnread: (projectId: string) => void
  markSessionCompleted: (sessionId: string) => void
  markSessionRead: (sessionId: string) => void
  markSessionStarted: (sessionId: string) => void
  resetResolvedFailures: (
    failedWorkflows: Record<string, boolean>,
    failedSessions: Record<string, boolean>,
  ) => void
}

/** Write the persisted slice back after any change to the acknowledgement markers. */
function persistReadMarkers(get: () => SidebarActivityState): void {
  const { readFailedWorkflows, readFailedSessions, readFailedProjects } = get()
  saveSidebarActivityReadState({ readFailedWorkflows, readFailedSessions, readFailedProjects })
}

/**
 * Drop markers whose failure has resolved, so a later failure is not swallowed by a
 * stale acknowledgement. Entries with no current failure data (`undefined`) are kept:
 * their project's sessions are simply not loaded in this tab session.
 * Returns the same reference when nothing changed.
 */
function pruneResolved(
  markers: Record<string, true>,
  failed: Record<string, boolean>,
): Record<string, true> {
  const entries = Object.entries(markers).filter(([id]) => failed[id] !== false)
  return entries.length === Object.keys(markers).length
    ? markers
    : (Object.fromEntries(entries) as Record<string, true>)
}

export const useSidebarActivityStore = create<SidebarActivityState>((set, get) => ({
  completedWorkflows: {},
  completedSessions: {},
  // Acknowledgements survive a reload; completion notices stay per-tab as before.
  ...loadSidebarActivityReadState(),

  markWorkflowCompleted: (projectId, workflowId) => set((state) => ({
    completedWorkflows: { ...state.completedWorkflows, [workflowId]: projectId },
  })),

  markWorkflowRead: (workflowId) => {
    set((state) => {
      const completedWorkflows = { ...state.completedWorkflows }
      delete completedWorkflows[workflowId]
      return {
        completedWorkflows,
        readFailedWorkflows: { ...state.readFailedWorkflows, [workflowId]: true },
      }
    })
    persistReadMarkers(get)
  },

  markWorkflowStarted: (workflowId) => {
    set((state) => {
      const completedWorkflows = { ...state.completedWorkflows }
      const readFailedWorkflows = { ...state.readFailedWorkflows }
      delete completedWorkflows[workflowId]
      delete readFailedWorkflows[workflowId]
      return { completedWorkflows, readFailedWorkflows }
    })
    persistReadMarkers(get)
  },

  markProjectRead: (projectId, workflowIds = [], sessionIds = []) => {
    set((state) => {
      const completedSessions = { ...state.completedSessions }
      for (const sessionId of sessionIds) delete completedSessions[sessionId]
      return {
        completedWorkflows: Object.fromEntries(
          Object.entries(state.completedWorkflows).filter(([, ownerId]) => ownerId !== projectId),
        ),
        completedSessions,
        readFailedWorkflows: {
          ...state.readFailedWorkflows,
          ...Object.fromEntries(workflowIds.map((workflowId) => [workflowId, true as const])),
        },
        readFailedSessions: {
          ...state.readFailedSessions,
          ...Object.fromEntries(sessionIds.map((sessionId) => [sessionId, true as const])),
        },
        readFailedProjects: { ...state.readFailedProjects, [projectId]: true as const },
      }
    })
    persistReadMarkers(get)
  },

  markProjectUnread: (projectId) => {
    const current = get()
    if (!current.readFailedProjects[projectId]) return
    const readFailedProjects = { ...current.readFailedProjects }
    delete readFailedProjects[projectId]
    set({ readFailedProjects })
    persistReadMarkers(get)
  },

  markSessionCompleted: (sessionId) => set((state) => ({
    completedSessions: { ...state.completedSessions, [sessionId]: true },
  })),

  markSessionRead: (sessionId) => {
    set((state) => {
      const completedSessions = { ...state.completedSessions }
      delete completedSessions[sessionId]
      return {
        completedSessions,
        readFailedSessions: { ...state.readFailedSessions, [sessionId]: true },
      }
    })
    persistReadMarkers(get)
  },

  markSessionStarted: (sessionId) => {
    set((state) => {
      const completedSessions = { ...state.completedSessions }
      const readFailedSessions = { ...state.readFailedSessions }
      delete completedSessions[sessionId]
      delete readFailedSessions[sessionId]
      return { completedSessions, readFailedSessions }
    })
    persistReadMarkers(get)
  },

  resetResolvedFailures: (failedWorkflows, failedSessions) => {
    const current = get()
    const readFailedWorkflows = pruneResolved(current.readFailedWorkflows, failedWorkflows)
    const readFailedSessions = pruneResolved(current.readFailedSessions, failedSessions)
    // Keep the reference when nothing changed so subscribers do not re-render:
    // the caller runs this from an effect over the derived failure maps.
    if (
      readFailedWorkflows === current.readFailedWorkflows
      && readFailedSessions === current.readFailedSessions
    ) return
    set({ readFailedWorkflows, readFailedSessions })
    persistReadMarkers(get)
  },
}))
