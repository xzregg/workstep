interface SearchableWorkflow {
  name: string
}

interface SearchableSession {
  title: string
}

interface SearchableProject<TWorkflow extends SearchableWorkflow> {
  name: string
  workflows?: TWorkflow[]
}

export function filterSidebarProject<
  TWorkflow extends SearchableWorkflow,
  TSession extends SearchableSession,
>(project: SearchableProject<TWorkflow>, sessions: TSession[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) {
    return {
      visible: true,
      projectMatches: true,
      workflows: project.workflows || [],
      sessions,
    }
  }

  const includesQuery = (value: string) => value.toLocaleLowerCase().includes(normalizedQuery)
  const workflows = (project.workflows || []).filter((workflow) => includesQuery(workflow.name))
  const matchingSessions = sessions.filter((session) => includesQuery(session.title))
  const projectMatches = includesQuery(project.name)

  return {
    visible: projectMatches || workflows.length > 0 || matchingSessions.length > 0,
    projectMatches,
    workflows,
    sessions: matchingSessions,
  }
}
