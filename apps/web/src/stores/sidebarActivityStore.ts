import { create } from 'zustand'

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

interface SidebarActivityState {
  completedWorkflows: Record<string, string>
  completedSessions: Record<string, true>
  markWorkflowCompleted: (projectId: string, workflowId: string) => void
  markWorkflowRead: (workflowId: string) => void
  markProjectRead: (projectId: string) => void
  markSessionCompleted: (sessionId: string) => void
  markSessionRead: (sessionId: string) => void
}

export const useSidebarActivityStore = create<SidebarActivityState>((set) => ({
  completedWorkflows: {},
  completedSessions: {},

  markWorkflowCompleted: (projectId, workflowId) => set((state) => ({
    completedWorkflows: { ...state.completedWorkflows, [workflowId]: projectId },
  })),

  markWorkflowRead: (workflowId) => set((state) => {
    if (!state.completedWorkflows[workflowId]) return state
    const completedWorkflows = { ...state.completedWorkflows }
    delete completedWorkflows[workflowId]
    return { completedWorkflows }
  }),

  markProjectRead: (projectId) => set((state) => ({
    completedWorkflows: Object.fromEntries(
      Object.entries(state.completedWorkflows).filter(([, ownerId]) => ownerId !== projectId),
    ),
  })),

  markSessionCompleted: (sessionId) => set((state) => ({
    completedSessions: { ...state.completedSessions, [sessionId]: true },
  })),

  markSessionRead: (sessionId) => set((state) => {
    if (!state.completedSessions[sessionId]) return state
    const completedSessions = { ...state.completedSessions }
    delete completedSessions[sessionId]
    return { completedSessions }
  }),
}))
