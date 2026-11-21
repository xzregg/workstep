import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, chatSessionApi } from '../../api/client'
import { loadInitialSessionHistory, type InitialSessionHistory } from '../../hooks/useChatSessionHistory'
import { useProjectStore } from '../../stores/projectStore'
import type { AssistantChatMessage } from '../../stores/assistantStore'
import { readDigitalPersonUiReply, type DigitalPersonUiAction } from './digitalPersonUiReply'

type Target = { projectId: string; sessionId: string; title: string; initialHistory?: InitialSessionHistory }
type Issue = 'unavailable' | 'missing' | 'ambiguous' | 'missingTarget' | 'forbidden' | 'detailUnavailable'
type OpenAction = Extract<DigitalPersonUiAction, { action: 'conversation.open' }>

export async function resolveDigitalPersonConversation(action: OpenAction, sourceSessionId: string):
Promise<{ target: Target } | { issue: Issue }> {
  const availableProjects = useProjectStore.getState().projects
  if ('session_id' in action) {
    const project = availableProjects.find(project => project.id === action.project_id)
    if (!project || action.session_id === sourceSessionId) return { issue: 'missingTarget' }
    try {
      const initialHistory = await loadInitialSessionHistory(action.session_id, project.id)
      const { detail } = initialHistory
      const matchesProject = detail.project_id === project.id ||
        (project.type === 'remote' && project.host_project_id && detail.project_id === project.host_project_id)
      if (detail.id !== action.session_id || !matchesProject) {
        return { issue: 'missingTarget' }
      }
      return { target: { projectId: project.id, sessionId: detail.id, title: detail.title, initialHistory } }
    } catch (reason) {
      if (reason instanceof ApiError) {
        if (reason.status === 404) return { issue: 'missingTarget' }
        if (reason.status === 403 || reason.status === 401) return { issue: 'forbidden' }
      }
      return { issue: 'detailUnavailable' }
    }
  }
  const projects = availableProjects.filter(project => !action.project ||
    project.name === action.project || project.id === action.project)
  if (!projects.length) return { issue: 'missing' }
  const results = await Promise.allSettled(projects.map(async project => {
    const { sessions } = await chatSessionApi.list(project.id)
    return sessions.filter(session => session.id !== sourceSessionId && session.title.trim() === action.title)
      .map(session => ({ projectId: project.id, sessionId: session.id, title: session.title }))
  }))
  if (results.some(result => result.status === 'rejected')) return { issue: 'unavailable' }
  const matches = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  if (matches.length !== 1) return { issue: matches.length ? 'ambiguous' : 'missing' }
  return { target: matches[0] }
}

export function useDigitalPersonUiActions(active: boolean, sessionId: string, reply?: AssistantChatMessage) {
  const scope = active ? sessionId : null
  const [previousScope, setPreviousScope] = useState(scope)
  const [panel, setPanel] = useState<(Target & { id: string; closing: boolean }) | null>(null)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [opening, setOpening] = useState(false)
  const consumed = useRef<string | undefined>(undefined)
  const version = useRef(0)
  if (scope !== previousScope) {
    setPreviousScope(scope)
    setPanel(null)
    setIssue(null)
    setOpening(false)
  }
  const cancelLookup = useCallback(() => { version.current++ }, [])
  useEffect(() => cancelLookup, [scope, cancelLookup])

  const close = useCallback(() => {
    cancelLookup()
    setIssue(null)
    setOpening(false)
    setPanel(current => current && !current.closing ? { ...current, closing: true } : current)
  }, [cancelLookup])

  useEffect(() => {
    if (!active) {
      consumed.current = reply?.id
      return
    }
    if (!reply || reply.role !== 'assistant' || reply.status === 'running' || consumed.current === reply.id) return
    consumed.current = reply.id
    if (reply.status !== 'succeeded' || reply.proactive) return
    const { action } = readDigitalPersonUiReply(reply.content)
    if (!action) return
    if (action.action === 'window.close') {
      // eslint-disable-next-line react/set-state-in-effect -- A completed model reply is an external command.
      close()
      return
    }
    const request = ++version.current
    // eslint-disable-next-line react/set-state-in-effect -- A completed model reply is an external command.
    setOpening(true)
    void resolveDigitalPersonConversation(action, sessionId).then(result => {
      if (request !== version.current) return
      setOpening(false)
      if ('issue' in result) {
        setIssue(result.issue)
      } else {
        setIssue(null)
        setPanel({ ...result.target, id: reply.id, closing: false })
      }
    })
  }, [active, reply, sessionId, close])

  return { panel: active ? panel : null, issue: active ? issue : null, opening: active && opening, close,
    finishClosing: (id: string) => setPanel(current => current?.id === id && current.closing ? null : current) }
}
