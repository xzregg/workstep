import { create } from 'zustand'
import { projectApi, remoteProjectApi, workflowApi, type Project, type WorkflowDetail } from '../api/client'
import { zhCNT } from '../i18n'

const hasWhitespace = (s: string) => /\s/.test(s)

interface ProjectState {
  projects: Project[]
  activeProject: Project | null
  activeWorkflowId: string | null
  loading: boolean
  canvasDirty: boolean

  fetchProjects: () => Promise<void>
  setActiveProject: (p: Project | null) => void
  setActiveWorkflow: (id: string | null) => void
  setCanvasDirty: (d: boolean) => void
  initProject: (path: string, name?: string) => Promise<Project>
  addRemoteProject: (shareString: string) => Promise<Project>
  renameProject: (path: string, name: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<Project | null>
  createWorkflow: (projectId: string, name: string, templateId?: string, steps?: any) => Promise<WorkflowDetail>
  deleteWorkflow: (id: string, projectId: string) => Promise<void>
  restoreWorkflow: (id: string, projectId: string) => Promise<void>
  reorderWorkflows: (projectId: string, orderedIds: string[]) => Promise<void>
  renameWorkflow: (id: string, projectId: string, name: string) => Promise<WorkflowDetail>
  saveSteps: (projectId: string, steps: any) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProject: null,
  activeWorkflowId: null,
  loading: false,
  canvasDirty: false,

  fetchProjects: async () => {
    if (useProjectStore.getState().loading) return
    set({ loading: true })
    try {
      const { projects } = await projectApi.list()
      set({ projects, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setActiveProject: (p) => {
    const prev = get().activeProject
    set({ activeProject: p })
    // Auto-select default workflow when switching projects
    if (p && p.id !== prev?.id) {
      const defaultWf = p.workflows?.find(w => w.is_default) || p.workflows?.[0]
      set({ activeWorkflowId: defaultWf?.id || null })
    }
    if (!p) set({ activeWorkflowId: null })
  },

  setCanvasDirty: (d) => set({ canvasDirty: d }),

  restoreWorkflow: async (id: string, projectId: string) => {
    await workflowApi.restore(id, projectId)
    const { activeProject } = get()
    if (activeProject && activeProject.id === projectId) {
      const updated = {
        ...activeProject,
        workflows: (activeProject.workflows || []).map((w: any) =>
          w.id === id ? { ...w, deleted: false } : w
        ),
      }
      set({ activeProject: updated })
      set((s) => ({
        projects: s.projects.map((p: any) => p.id === projectId ? updated : p),
      }))
    }
  },

  reorderWorkflows: async (projectId: string, orderedIds: string[]) => {
    const { projects, activeProject } = get()
    const target = projects.find((p) => p.id === projectId)
    if (!target) return
    const orderMap = new Map(orderedIds.map((id, index) => [id, index]))
    const workflows = [...(target.workflows || [])].sort((a, b) =>
      (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
    const updated = { ...target, workflows }
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }))
    if (activeProject?.id === projectId) set({ activeProject: updated })
    try {
      await workflowApi.reorder(projectId, orderedIds)
    } catch {
      await get().fetchProjects()
    }
  },

  renameWorkflow: async (id: string, projectId: string, name: string) => {
    if (hasWhitespace(name)) throw new Error(zhCNT('taskList.workflowNameWhitespace'))
    const wf = await workflowApi.update(id, projectId, name)
    const { activeProject } = get()
    if (activeProject?.id === projectId) {
      const updated = {
        ...activeProject,
        workflows: (activeProject.workflows || []).map((w: any) =>
          w.id === id ? { ...w, name: wf.name } : w
        ),
      }
      set({ activeProject: updated })
      set((s) => ({
        projects: s.projects.map((p: any) => p.id === projectId ? updated : p),
      }))
    }
    return wf
  },

  setActiveWorkflow: async (id) => {
    set({ activeWorkflowId: id })
    if (id) {
      const { activeProject } = get()
      if (activeProject?.id) {
        try {
          const wf = await workflowApi.get(id, activeProject.id)
          set((s) => s.activeProject?.id === activeProject.id
            ? { activeProject: { ...activeProject, steps: wf.steps } }
            : {})
        } catch (e) {
          console.error('Failed to load workflow steps:', e)
        }
      }
    }
  },

  initProject: async (path, name) => {
    if (name && hasWhitespace(name)) throw new Error(zhCNT('taskList.projectNameWhitespace'))
    const proj = await projectApi.init(path, name)
    set((s) => ({ projects: [...s.projects, proj] }))
    return proj
  },

  addRemoteProject: async (shareString) => {
    const project = await remoteProjectApi.add(shareString.trim())
    set((state) => ({
      projects: [...state.projects.filter((item) => item.id !== project.id), project],
    }))
    return project
  },

  renameProject: async (path, name) => {
    if (hasWhitespace(name)) throw new Error(zhCNT('taskList.projectNameWhitespace'))
    await projectApi.rename(path, name)
    set((s) => ({
      projects: s.projects.map((p) =>
        p.path === path ? { ...p, name } : p,
      ),
    }))
  },

  deleteProject: async (projectId) => {
    await projectApi.delete(projectId)
    const { projects, activeProject } = get()
    const remaining = projects.filter((project) => project.id !== projectId)
    if (activeProject?.id !== projectId) {
      set({ projects: remaining })
      return activeProject
    }

    const next = remaining[0] ?? null
    const defaultWorkflow = next?.workflows?.find((workflow) => workflow.is_default)
      ?? next?.workflows?.[0]
    set({
      projects: remaining,
      activeProject: next,
      activeWorkflowId: defaultWorkflow?.id ?? null,
      canvasDirty: false,
    })
    return next
  },

  createWorkflow: async (projectId, name, templateId, steps) => {
    if (hasWhitespace(name)) throw new Error(zhCNT('taskList.workflowNameWhitespace'))
    const wf = await workflowApi.create(projectId, name, steps, templateId)
    const { activeProject } = get()
    if (activeProject && activeProject.id === projectId) {
      const summary = {
        id: wf.id,
        name: wf.name,
        is_default: wf.is_default,
        nodeCount: (wf.steps?.nodes || wf.steps?.steps || []).length,
      }
      const updated = {
        ...activeProject,
        workflows: [...(activeProject.workflows || []), summary],
      }
      set({ activeProject: updated })
      set((s) => ({
        projects: s.projects.map(p => p.id === projectId ? updated : p),
      }))
    }
    return wf
  },

  deleteWorkflow: async (id, projectId) => {
    const res = await workflowApi.delete(id, projectId)
    const { activeProject, activeWorkflowId } = get()
    if (activeProject && activeProject.id === projectId) {
      const workflows = res.soft
        // Soft delete → keep the row, mark as deleted (recycle bin)
        ? (activeProject.workflows || []).map(w => w.id === id ? { ...w, deleted: true } : w)
        // Hard delete → remove permanently
        : (activeProject.workflows || []).filter(w => w.id !== id)
      const updated = { ...activeProject, workflows }
      set({ activeProject: updated })
      set((s) => ({
        projects: s.projects.map(p => p.id === projectId ? updated : p),
      }))
      // If deleted the active workflow, switch to default
      if (activeWorkflowId === id) {
        const defaultWf = updated.workflows.find(w => w.is_default && !w.deleted) || updated.workflows.find(w => !w.deleted)
        set({ activeWorkflowId: defaultWf?.id || null })
      }
    }
  },

  saveSteps: async (projectId, steps) => {
    const { activeWorkflowId } = get()
    await projectApi.saveSteps(projectId, steps, activeWorkflowId || undefined)
    const { activeProject } = get()
    if (activeProject && activeProject.id === projectId) {
      set({ activeProject: { ...activeProject, steps }, canvasDirty: false })
    }
  },
}))
