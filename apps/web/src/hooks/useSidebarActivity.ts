import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { mergeChatSessionRunningState, useChatListStore, useChatSessionStore } from '../stores/chatSessionStore'
import { useProjectStore } from '../stores/projectStore'
import {
  deriveSessionFailedStateFromLastStatus,
  deriveWorkflowFailedState,
  deriveWorkflowRunningState,
  useSidebarActivityStore,
} from '../stores/sidebarActivityStore'
import { useTaskStore } from '../stores/taskStore'

/** A failure the user already opened is acknowledged: it must not keep the dot lit. */
function acknowledgeFailures(
  failed: Record<string, boolean>,
  read: Record<string, true>,
): Record<string, boolean> {
  if (!Object.keys(read).length) return failed
  return Object.fromEntries(
    Object.entries(failed).map(([id, isFailed]) => [id, isFailed && !read[id]]),
  )
}

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
  // Failures the user already opened. The indicator must not stay lit just because
  // the last run happened to fail — opening the item acknowledges it.
  const readFailedWorkflows = useSidebarActivityStore((state) => state.readFailedWorkflows)
  const readFailedSessions = useSidebarActivityStore((state) => state.readFailedSessions)
  const readFailedProjects = useSidebarActivityStore((state) => state.readFailedProjects)
  // 流式输出会在每个 token 上重建 `sessions` 对象：订阅整个对象会让侧栏（Layout 全树）
  // 每个 token 重渲染一次，页面切换点击因此排队卡顿。这里只订阅两个派生映射，
  // useShallow 保证值不变时引用稳定，流式期间 Layout 完全静默。
  const liveRunningChatSessions = useChatSessionStore(useShallow(
    (state) => Object.fromEntries(Object.entries(state.sessions).map(
      ([id, session]) => [id, session.running],
    )),
  ))
  const liveLastMessageStatus = useChatSessionStore(useShallow(
    (state) => Object.fromEntries(Object.entries(state.sessions).map(
      ([id, session]) => [id, session.messages.at(-1)?.status ?? null],
    )),
  ))
  const runningChatSessions = useMemo(
    () => mergeChatSessionRunningState(sessions, liveRunningChatSessions),
    [liveRunningChatSessions, sessions],
  )
  /** Raw failure state, before acknowledgements. Drives marker pruning. */
  const rawFailedChatSessions = useMemo(
    () => deriveSessionFailedStateFromLastStatus(sessions, liveLastMessageStatus),
    [liveLastMessageStatus, sessions],
  )
  const rawFailedWorkflows = useMemo(
    () => deriveWorkflowFailedState(projects, tasks, activeProject?.id),
    [activeProject?.id, projects, tasks],
  )
  const failedChatSessions = useMemo(() => (
    acknowledgeFailures(rawFailedChatSessions, readFailedSessions)
  ), [rawFailedChatSessions, readFailedSessions])
  const failedWorkflows = useMemo(() => (
    acknowledgeFailures(rawFailedWorkflows, readFailedWorkflows)
  ), [rawFailedWorkflows, readFailedWorkflows])
  const workflowRunningRef = useRef<Record<string, boolean> | null>(null)
  const sessionRunningRef = useRef<Record<string, boolean> | null>(null)
  const previousRunningSessionKeyRef = useRef('')
  const [sessionProjectMap, setSessionProjectMap] = useState<Record<string, string>>({})

  // Acknowledgements are persisted, so a marker outlives the failure it silenced.
  // Once a failure resolves, drop its marker — otherwise a *new* failure of the same
  // item (e.g. one that happened while the app was closed) would stay hidden.
  useEffect(() => {
    useSidebarActivityStore.getState().resetResolvedFailures(
      rawFailedWorkflows,
      rawFailedChatSessions,
    )
  }, [rawFailedChatSessions, rawFailedWorkflows])

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
          // A finished run is a new outcome: drop the acknowledgement of the
          // previous failure so this run's failure can raise the indicator again.
          const activity = useSidebarActivityStore.getState()
          activity.markWorkflowStarted(workflowId)
          if (alreadyViewing) {
            useSidebarActivityStore.getState().markWorkflowRead(workflowId)
          } else {
            useSidebarActivityStore.getState().markWorkflowCompleted(
              workflowProjects[workflowId],
              workflowId,
            )
            // The project roll-up must be able to light up again for this outcome.
            useSidebarActivityStore.getState().markProjectUnread(workflowProjects[workflowId])
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
        } else if (!running && previous[sessionId] === true) {
          // A finished turn is a new outcome: drop the acknowledgement of the
          // previous failure so this turn's failure can raise the indicator again.
          const activity = useSidebarActivityStore.getState()
          activity.markSessionStarted(sessionId)
          if (activeSessionId === sessionId) {
            useSidebarActivityStore.getState().markSessionRead(sessionId)
          } else {
            useSidebarActivityStore.getState().markSessionCompleted(sessionId)
            const ownerProjectId = sessionProjectMap[sessionId]
              || sessions.find((session) => session.id === sessionId)?.project_id
            if (ownerProjectId) {
              // The project roll-up must be able to light up again for this outcome.
              useSidebarActivityStore.getState().markProjectUnread(ownerProjectId)
            }
          }
        }
      }
    }
    sessionRunningRef.current = runningChatSessions
  }, [activeSessionId, runningChatSessions, sessionProjectMap, sessions])

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

  const projectHasFailedSession = (projectId: string) =>
    sessions.some((session) => session.project_id === projectId && failedChatSessions[session.id])
    || Object.entries(failedChatSessions).some(
      ([sessionId, failed]) => failed && sessionProjectMap[sessionId] === projectId,
    )

  /**
   * Acknowledge a whole project. Passing only the project id would clear nothing:
   * the failure markers live on the child workflows/sessions, and a collapsed
   * project's sessions may not be loaded yet — hence the project-level marker.
   */
  const markProjectRead = useCallback((projectId: string) => {
    const project = projects.find((item) => item.id === projectId)
    const workflowIds = (project?.workflows || []).map((workflow) => workflow.id)
    const sessionIds = new Set(
      sessions
        .filter((session) => session.project_id === projectId)
        .map((session) => session.id),
    )
    for (const [sessionId, ownerId] of Object.entries(sessionProjectMap)) {
      if (ownerId === projectId) sessionIds.add(sessionId)
    }
    useSidebarActivityStore.getState().markProjectRead(projectId, workflowIds, [...sessionIds])
  }, [projects, sessionProjectMap, sessions])

  /** Project roll-up: any unacknowledged failed workflow or chat session. */
  const projectHasFailure = (projectId: string) => {
    if (readFailedProjects[projectId]) return false
    const project = projects.find((item) => item.id === projectId)
    return Boolean(project?.workflows?.some((workflow) => failedWorkflows[workflow.id]))
      || projectHasFailedSession(projectId)
  }

  return {
    completedSessions,
    completedWorkflows,
    markProjectRead,
    projectHasFailure,
    projectHasRunningSession,
    projectHasFailedSession,
    failedChatSessions,
    failedWorkflows,
    runningChatSessions,
  }
}
