import { useEffect } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'

/** Keep project/workflow state aligned with an explicit task-list URL. */
export function useProjectRouteSelection() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const projectName = params.get('project')
  const workflowId = params.get('workflow')
  const taskId = params.get('task')
  const projects = useProjectStore((state) => state.projects)
  const activeProject = useProjectStore((state) => state.activeProject)
  const activeProjectId = activeProject?.id
  const activeWorkflowId = useProjectStore((state) => state.activeWorkflowId)
  const setActiveProject = useProjectStore((state) => state.setActiveProject)
  const setActiveWorkflow = useProjectStore((state) => state.setActiveWorkflow)

  useEffect(() => {
    if (location.pathname !== '/tasks') return
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

    // A task deep link may hydrate an empty store, but it should not pull an
    // already-open detail panel to another project during a transient refresh.
    if (!activeProjectId || (!taskId && activeProjectId !== project.id)) {
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
    taskId,
    workflowId,
  ])
}
