import { create } from 'zustand'
import { projectApi, type Project } from '../api/client'

interface ProjectState {
  projects: Project[]
  activeProject: Project | null
  loading: boolean

  fetchProjects: () => Promise<void>
  setActiveProject: (p: Project | null) => void
  initProject: (path: string, name?: string) => Promise<Project>
  renameProject: (path: string, name: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProject: null,
  loading: false,

  fetchProjects: async () => {
    if (useProjectStore.getState().loading) return // Prevent double-fetch
    set({ loading: true })
    try {
      const { projects } = await projectApi.list()
      set({ projects, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setActiveProject: (p) => set({ activeProject: p }),

  initProject: async (path, name) => {
    const proj = await projectApi.init(path, name)
    set((s) => ({ projects: [...s.projects, proj] }))
    return proj
  },

  renameProject: async (path, name) => {
    await projectApi.rename(path, name)
    set((s) => ({
      projects: s.projects.map((p) =>
        p.path === path ? { ...p, name } : p,
      ),
    }))
  },
}))
