import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { mergeChatSessionRunningState, useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useProjectStore } from '../stores/projectStore'
import { deriveWorkflowRunningState, useSidebarActivityStore } from '../stores/sidebarActivityStore'
import { useTaskStore } from '../stores/taskStore'

export function useSidebarActivity(activeSessionId: string | null) {
  const location = useLocation()
  const projects = useProjectStore((state) => state.projects)
  const activeProject = useProjectStore((state) => state.activeProject)
  const activeWorkflowId = useProjectStore((state) => state.activeWorkflowId)
  const fetchProjects = useProjectStore((state) => state.fetchProjects)
  const tasks = useTaskStore((state) => state.tasks)
  const sessions = useChatListStore((state) => state.sessions)
  const completedWorkflows = useSidebarActivityStore((state) => state.completedWorkflows)
  const completedSessions = useSidebarActivityStore((state) => state.completedSessions)
  const liveRunningChatSessions = useChatSessionStore(
    useShallow((state) => Object.fromEntries(
      Object.entries(state.sessions).map(([id, session]) => [id, session.running]),
    )),
  )
  const runningChatSessions = useMemo(
    () => mergeChatSessionRunningState(sessions, liveRunningChatSessions),
    [liveRunningChatSessions, sessions],
  )
  const workflowRunningRef = useRef<Record<string, boolean> | null>(null)
  const sessionRunningRef = useRef<Record<string, boolean> | null>(null)
  const previousRunningSessionKeyRef = useRef('')
  const [sessionProjectMap, setSessionProjectMap] = useState<Record<string, string>>({})

  useEffect(() => {
    const current = deriveWorkflowRunningState(projects, tasks, activeProject?.id)
    const workflowProjects: Record<string, string> = {}
    for (const project of projects) {
      for (const workflow of project.workflows || []) {
        workflowProjects[workflow.id] = project.id
      }
    }
    const previous = workflowRunningRef.current
    if (previous) {
      for (const [workflowId, running] of Object.entries(current)) {
        if (running && previous[workflowId] === false) {
          useSidebarActivityStore.getState().markWorkflowRead(workflowId)
        } else if (!running && previous[workflowId] === true) {
          const alreadyViewing = location.pathname === '/tasks'
            && activeProject?.id === workflowProjects[workflowId]
            && activeWorkflowId === workflowId
          if (!alreadyViewing) {
            useSidebarActivityStore.getState().markWorkflowCompleted(
              workflowProjects[workflowId],
              workflowId,
            )
          }
        }
      }
    }
    workflowRunningRef.current = current
  }, [activeProject?.id, activeWorkflowId, location.pathname, projects, tasks])

  useEffect(() => {
    const previous = sessionRunningRef.current
    if (previous) {
      for (const [sessionId, running] of Object.entries(runningChatSessions)) {
        if (running && previous[sessionId] === false) {
          useSidebarActivityStore.getState().markSessionRead(sessionId)
        } else if (!running && previous[sessionId] === true && activeSessionId !== sessionId) {
          useSidebarActivityStore.getState().markSessionCompleted(sessionId)
        }
      }
    }
    sessionRunningRef.current = runningChatSessions
  }, [activeSessionId, runningChatSessions])

  useEffect(() => {
    if (activeSessionId) useSidebarActivityStore.getState().markSessionRead(activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    if (!activeProject?.id) return
    void useChatListStore.getState().fetchSessions(activeProject.id)
  }, [activeProject?.id])

  useEffect(() => {
    setSessionProjectMap((previous) => {
      let changed = false
      const next = { ...previous }
      for (const item of sessions) {
        if (item.project_id && next[item.id] !== item.project_id) {
          next[item.id] = item.project_id
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [sessions])

  const runningSessionKey = Object.entries(runningChatSessions)
    .filter(([, running]) => running)
    .map(([sessionId]) => sessionId)
    .sort()
    .join(',')

  useEffect(() => {
    const previous = previousRunningSessionKeyRef.current
    previousRunningSessionKeyRef.current = runningSessionKey
    if (!previous && !runningSessionKey) return
    const timer = window.setTimeout(() => { void fetchProjects() }, 300)
    return () => window.clearTimeout(timer)
  }, [runningSessionKey, fetchProjects])

  const projectHasRunningSession = (projectId: string) =>
    sessions.some((session) => session.project_id === projectId && session.running)
    || Object.entries(runningChatSessions).some(
      ([sessionId, running]) => running && sessionProjectMap[sessionId] === projectId,
    )

  return {
    completedSessions,
    completedWorkflows,
    projectHasRunningSession,
    runningChatSessions,
  }
}
