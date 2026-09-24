import { useCallback, useEffect, useRef, useState } from 'react'
import { projectActionApi, taskActionApi, type ActionRun, type ChatQuickButton } from '../api/client'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'

export function useProjectActions(projectId: string | undefined, sessionId: string | null) {
  const { t } = useI18n()
  const [runs, setRuns] = useState<ActionRun[]>([])
  const [activeActionIds, setActiveActionIds] = useState<string[]>([])
  const [pending, setPending] = useState<ChatQuickButton | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const scopeRef = useRef('')
  scopeRef.current = `${projectId || ''}:${sessionId || ''}`
  useEffect(() => {
    setRuns([])
    setActiveActionIds([])
    setPending(null)
    setError('')
  }, [projectId, sessionId])
  const refresh = useCallback(async () => {
    if (!projectId || !sessionId || inFlight.current) return
    const scope = scopeRef.current
    inFlight.current = true
    try {
      const result = await projectActionApi.list(sessionId, projectId)
      if (scope === scopeRef.current) {
        setRuns(result.runs)
        setActiveActionIds(result.active_action_ids)
      }
    } catch (reason) {
      if (scope === scopeRef.current) setError(reason instanceof Error ? reason.message : t('actionShortcuts.loadFailed'))
    } finally {
      inFlight.current = false
    }
  }, [projectId, sessionId, t])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const hasActiveAction = activeActionIds.length > 0 || runs.some((run) => ['preparing', 'running', 'stopping'].includes(run.status))
  useEffect(() => {
    if (!hasActiveAction) return
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => window.clearInterval(timer)
  }, [hasActiveAction, refresh])

  const run = async (button: ChatQuickButton, confirmed = false) => {
    if (!projectId || !sessionId || busy || activeActionIds.includes(button.action_id || '')) return
    if (button.require_confirmation !== false && !confirmed) { setPending(button); return }
    setBusy(true)
    setError('')
    try {
      const result = await projectActionApi.run(sessionId, projectId, button.id, confirmed)
      setRuns((current) => [result, ...current.filter((item) => item.run_id !== result.run_id)])
      setActiveActionIds((current) => [...current, result.action_id])
      setPending(null)
      void refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('actionShortcuts.startFailed'))
    } finally {
      setBusy(false)
    }
  }
  const stop = async (runId: string) => {
    if (!projectId) return
    try {
      const result = await taskActionApi.stop(runId, projectId)
      setRuns((current) => current.map((item) => item.run_id === runId ? result : item))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('actionShortcuts.stopFailed'))
    }
  }
  return { runs, activeActionIds, pending, busy, error, setPending, run, stop }
}

export function ProjectActionMessages({ state }: { state: ReturnType<typeof useProjectActions> }) {
  const { t } = useI18n()
  return <>
    {state.error && <div role="alert" style={{ color: 'var(--danger)' }}>{state.error}</div>}
    <ConfirmDialog
      open={Boolean(state.pending)} title={t('actionShortcuts.confirmTitle', { title: state.pending?.label || '' })}
      message={state.pending ? t('actionShortcuts.confirmMessage', { script: state.pending.script_path || '', directory: t('actionShortcuts.projectDirectory') }) : ''}
      confirmText={t('actionShortcuts.confirm')} loading={state.busy}
      onCancel={() => state.setPending(null)}
      onConfirm={() => { if (state.pending) void state.run(state.pending, true) }}
    />
  </>
}
