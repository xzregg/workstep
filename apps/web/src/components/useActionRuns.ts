import { useCallback, useEffect, useRef, useState } from 'react'
import { projectActionApi, taskActionApi, type ActionRun, type ChatQuickButton, type TaskQuickButton } from '../api/client'
import { useI18n } from '../i18n'

const isActive = (status: string) => ['preparing', 'running', 'stopping'].includes(status)

type TaskScope = { kind: 'task'; projectId?: string; taskId?: string; stepKey?: string; onChanged?: () => void }
type ProjectScope = { kind: 'project'; projectId?: string; sessionId: string | null }
type Button = TaskQuickButton | ChatQuickButton
type BaseState = {
  runs: ActionRun[]
  busy: boolean
  error: string
  stop: (runId: string) => Promise<void>
}
type TaskState = BaseState & {
  buttons: TaskQuickButton[]
  pending: TaskQuickButton | null
  setPending: (button: TaskQuickButton | null) => void
  run: (button: TaskQuickButton, confirmed?: boolean, actionInput?: string) => Promise<void>
}
type ProjectState = BaseState & {
  activeActionIds: string[]
  pending: ChatQuickButton | null
  setPending: (button: ChatQuickButton | null) => void
  run: (button: ChatQuickButton, confirmed?: boolean, actionInput?: string) => Promise<void>
}

export function useActionRuns(scope: TaskScope): TaskState
export function useActionRuns(scope: ProjectScope): ProjectState
export function useActionRuns(scope: TaskScope | ProjectScope): TaskState | ProjectState {
  const { t } = useI18n()
  const { kind, projectId } = scope
  const taskId = scope.kind === 'task' ? scope.taskId : undefined
  const stepKey = scope.kind === 'task' ? scope.stepKey : undefined
  const sessionId = scope.kind === 'project' ? scope.sessionId : null
  const onChanged = scope.kind === 'task' ? scope.onChanged : undefined
  const [buttons, setButtons] = useState<TaskQuickButton[]>([])
  const [runs, setRuns] = useState<ActionRun[]>([])
  const [activeActionIds, setActiveActionIds] = useState<string[]>([])
  const [pending, setPending] = useState<Button | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlightScopes = useRef(new Set<string>())
  const scopeKey = `${kind}:${projectId || ''}:${taskId || sessionId || ''}:${stepKey || ''}`
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey

  const refresh = useCallback(async () => {
    if (!projectId || (kind === 'task' ? !taskId : !sessionId)) return
    const key = currentScope.current
    if (inFlightScopes.current.has(key)) return
    inFlightScopes.current.add(key)
    try {
      if (kind === 'task') {
        const result = await taskActionApi.list(taskId!, projectId, stepKey)
        if (key === currentScope.current) {
          setButtons(result.buttons)
          setRuns(result.runs)
        }
      } else {
        const result = await projectActionApi.list(sessionId!, projectId)
        if (key === currentScope.current) {
          setRuns(result.runs)
          setActiveActionIds(result.active_action_ids)
        }
      }
    } catch (reason) {
      if (key === currentScope.current) setError(reason instanceof Error ? reason.message : t('actionShortcuts.loadFailed'))
    } finally {
      inFlightScopes.current.delete(key)
    }
  }, [kind, projectId, taskId, stepKey, sessionId, t])

  useEffect(() => {
    setButtons([])
    setRuns([])
    setActiveActionIds([])
    setPending(null)
    setBusy(false)
    setError('')
  }, [scopeKey])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (kind !== 'task' || !projectId || !taskId) return
    const onFocus = () => { void refresh() }
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [kind, projectId, taskId, refresh])
  const hasActiveAction = activeActionIds.length > 0 || runs.some(run => isActive(run.status))
  useEffect(() => {
    if (!hasActiveAction) return
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => window.clearInterval(timer)
  }, [hasActiveAction, refresh])

  const run = async (button: Button, confirmed = false, actionInput = '') => {
    if (!projectId || busy || (kind === 'task' ? !taskId : !sessionId)) return
    const actionId = button.action_id || ''
    if (kind === 'project' ? activeActionIds.includes(actionId)
      : runs.some(item => item.action_id === actionId && isActive(item.status))) return
    if (button.require_confirmation !== false && !confirmed) { setPending(button); return }
    const key = currentScope.current
    setBusy(true)
    setError('')
    try {
      const result = kind === 'task'
        ? await taskActionApi.run(taskId!, projectId, button as TaskQuickButton, confirmed, actionInput)
        : await projectActionApi.run(sessionId!, projectId, button.id, confirmed, actionInput)
      if (key !== currentScope.current) return
      setRuns(current => [result, ...current.filter(item => item.run_id !== result.run_id)])
      if (kind === 'project') setActiveActionIds(current => [...current, result.action_id])
      setPending(null)
      onChanged?.()
      void refresh()
    } catch (reason) {
      if (key === currentScope.current) setError(reason instanceof Error ? reason.message : t('actionShortcuts.startFailed'))
    } finally {
      if (key === currentScope.current) setBusy(false)
    }
  }
  const stop = async (runId: string) => {
    if (!projectId) return
    const key = currentScope.current
    setError('')
    try {
      const result = await taskActionApi.stop(runId, projectId)
      if (key === currentScope.current) setRuns(current => current.map(item => item.run_id === runId ? result : item))
    } catch (reason) {
      if (key === currentScope.current) setError(reason instanceof Error ? reason.message : t('actionShortcuts.stopFailed'))
    }
  }
  const state = { buttons, runs, activeActionIds, pending, busy, error, setPending, run, stop }
  return kind === 'task' ? state as TaskState : state as ProjectState
}

export function useTaskActions(projectId: string | undefined, taskId: string | undefined, stepKey: string | undefined, onChanged?: () => void) {
  return useActionRuns({ kind: 'task', projectId, taskId, stepKey, onChanged })
}

export function useProjectActions(projectId: string | undefined, sessionId: string | null) {
  return useActionRuns({ kind: 'project', projectId, sessionId })
}
