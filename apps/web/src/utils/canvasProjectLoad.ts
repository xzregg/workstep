import type { Project } from '../api/client'

interface ResolveCanvasProjectOptions {
  projectName: string
  activeProject: Project | null
  projects: Project[]
  refreshProjects: () => Promise<void>
  getProjects: () => Project[]
}

export async function resolveCanvasProject({
  projectName,
  activeProject,
  projects,
  refreshProjects,
  getProjects,
}: ResolveCanvasProjectOptions): Promise<Project | undefined> {
  if (activeProject?.name === projectName) return activeProject

  const existing = projects.find((project) => project.name === projectName)
  if (existing) return existing

  await refreshProjects()
  return getProjects().find((project) => project.name === projectName)
}
