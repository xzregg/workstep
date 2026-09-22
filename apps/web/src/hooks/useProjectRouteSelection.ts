import { useEffect } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'

/** Keep project/workflow state aligned with an explicit task-list URL. */
export function useProjectRouteSelection() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const projectName = params.get('project')
  const workflowId = params.get('workflow')
  const projects = useProjectStore((state) => state.projects)
  const activeProject = useProjectStore((state) => state.activeProject)
  const activeProjectId = activeProject?.id
  const activeWorkflowId = useProjectStore((state) => state.activeWorkflowId)
  const setActiveProject = useProjectStore((state) => state.setActiveProject)
  const setActiveWorkflow = useProjectStore((state) => state.setActiveWorkflow)

  useEffect(() => {
    if (location.pathname !== '/tasks' && location.pathname !== '/chat') return
    if (location.pathname === '/chat') {
      if (!projectName || projects.length === 0) return
      const project = projects.find(item => item.name === projectName)
      if (project && activeProjectId !== project.id) setActiveProject(project)
      return
    }
    if (
      activeProject
      && activeWorkflowId
      && (!projectName || projectName === activeProject.name)
      && (!projectName || !workflowId)
    ) {
      const next = new URLSearchParams(params)
      if (!projectName) next.set('project', activeProject.name)
      if (!workflowId) next.set('workflow', activeWorkflowId)
      setParams(next, { replace: true })
      return
    }
    if (!projectName || projects.length === 0) return
    const project = projects.find(item => item.name === projectName)
    if (!project) return

    // The URL is also updated when a task-dispatch stage opens its child task.
    // Keep the active project aligned even when another task detail is already
    // open, otherwise the child task renders the target project's default
    // steps instead of the workflow named by the URL.
    if (activeProjectId !== project.id) {
      setActiveProject(project)
    }

    const currentProjectId = useProjectStore.getState().activeProject?.id
    const workflowExists = project.workflows?.some(
      workflow => workflow.id === workflowId && !workflow.deleted,
    )
    if (
      workflowId
      && workflowExists
      && currentProjectId === project.id
      && activeWorkflowId !== workflowId
    ) {
      void setActiveWorkflow(workflowId)
    }
  }, [
    activeProjectId,
    activeProject,
    activeWorkflowId,
    location.pathname,
    projectName,
    projects,
    params,
    setActiveProject,
    setActiveWorkflow,
    setParams,
    workflowId,
  ])
}
