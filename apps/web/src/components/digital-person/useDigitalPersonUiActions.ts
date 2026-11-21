import { useCallback, useEffect, useRef, useState } from 'react'
import { chatSessionApi } from '../../api/client'
import { useProjectStore } from '../../stores/projectStore'
import type { AssistantChatMessage } from '../../stores/assistantStore'
import { readDigitalPersonUiReply, type DigitalPersonUiAction } from './digitalPersonUiReply'

type Target = { projectId: string; sessionId: string; title: string }
type Issue = 'unavailable' | 'missing' | 'ambiguous'
type OpenAction = Extract<DigitalPersonUiAction, { action: 'conversation.open' }>

export async function resolveDigitalPersonConversation(action: OpenAction, sourceSessionId: string):
Promise<{ target: Target } | { issue: Issue }> {
  const projects = useProjectStore.getState().projects.filter(project => !action.project ||
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
  const consumed = useRef<string | undefined>(undefined)
  const version = useRef(0)
  if (scope !== previousScope) {
    setPreviousScope(scope)
    setPanel(null)
    setIssue(null)
  }
  const cancelLookup = useCallback(() => { version.current++ }, [])
  useEffect(() => cancelLookup, [scope, cancelLookup])

  const close = useCallback(() => {
    cancelLookup()
    setIssue(null)
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
    void resolveDigitalPersonConversation(action, sessionId).then(result => {
      if (request !== version.current) return
      if ('issue' in result) {
        setIssue(result.issue)
      } else {
        setIssue(null)
        setPanel({ ...result.target, id: reply.id, closing: false })
      }
    })
  }, [active, reply, sessionId, close])

  return { panel: active ? panel : null, issue: active ? issue : null, close,
    finishClosing: (id: string) => setPanel(current => current?.id === id && current.closing ? null : current) }
}
