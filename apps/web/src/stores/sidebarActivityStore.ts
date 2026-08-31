import { create } from 'zustand'

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
