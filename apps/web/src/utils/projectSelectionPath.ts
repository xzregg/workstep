import { taskListPath } from '../hooks/useTaskRoute'

/**
 * Build the navigation target used when the user picks a project in the sidebar.
 *
 * The URL must carry the *clicked* project. Navigating to a bare `/tasks` leaves a
 * window where the still-mounted route hook reads the previous URL (e.g.
 * `/chat?project=workstep`) and writes the old project back into the store, after
 * which the bare task list is canonicalized to that stale project.
 */
export function projectSelectionPath(
  pathname: string,
  projectName: string,
  workflowId?: string | null,
): string {
  const encodedName = encodeURIComponent(projectName)
  if (pathname === '/canvas') return `/canvas?project=${encodedName}`
  if (pathname === '/schedules') return '/schedules'
  return workflowId ? taskListPath(projectName, workflowId) : `/tasks?project=${encodedName}`
}
