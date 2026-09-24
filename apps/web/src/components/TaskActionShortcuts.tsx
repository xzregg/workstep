import { useCallback, useEffect, useRef, useState } from 'react'
import { taskActionApi, type ActionRun, type TaskQuickButton } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import QuickPromptButton from './QuickPromptButton'

const isActive = (status: string) => ['preparing', 'running', 'stopping'].includes(status)

export function useTaskActions(projectId: string | undefined, taskId: string | undefined, stepKey: string | undefined, onChanged?: () => void) {
  const { t } = useI18n()
  const [buttons, setButtons] = useState<TaskQuickButton[]>([])
  const [runs, setRuns] = useState<ActionRun[]>([])
  const [pending, setPending] = useState<TaskQuickButton | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlightScope = useRef('')
  const scopeRef = useRef('')
  scopeRef.current = `${projectId || ''}:${taskId || ''}:${stepKey || ''}`
  const refresh = useCallback(async () => {
    if (!projectId || !taskId) return
    const scope = scopeRef.current
    if (inFlightScope.current === scope) return
    inFlightScope.current = scope
    try {
      const result = await taskActionApi.list(taskId, projectId, stepKey)
      if (scope === scopeRef.current) {
        setButtons(result.buttons)
        setRuns(result.runs)
      }
    } catch (reason) {
      if (scope === scopeRef.current) setError(reason instanceof Error ? reason.message : t('actionShortcuts.loadFailed'))
    } finally {
      if (inFlightScope.current === scope) inFlightScope.current = ''
    }
  }, [projectId, taskId, stepKey, t])

  useEffect(() => {
    setButtons([])
    setRuns([])
    setPending(null)
    setError('')
  }, [projectId, taskId, stepKey])

  useEffect(() => {
    void refresh()
  }, [refresh])
  const hasActiveAction = runs.some((run) => isActive(run.status))
  useEffect(() => {
    if (!hasActiveAction) return
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => window.clearInterval(timer)
  }, [hasActiveAction, refresh])

  const run = async (button: TaskQuickButton, confirmed = false) => {
    if (!projectId || !taskId || busy) return
    if (runs.some((item) => item.action_id === button.action_id && isActive(item.status))) return
    if (button.require_confirmation !== false && !confirmed) { setPending(button); return }
    setBusy(true)
    setError('')
    try {
      const result = await taskActionApi.run(taskId, projectId, button, confirmed)
      setRuns((current) => [result, ...current.filter((item) => item.run_id !== result.run_id)])
      setPending(null)
      onChanged?.()
      void refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('actionShortcuts.startFailed'))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (runId: string) => {
    if (!projectId) return
    setError('')
    try {
      const result = await taskActionApi.stop(runId, projectId)
      setRuns((current) => current.map((item) => item.run_id === runId ? result : item))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('actionShortcuts.stopFailed'))
    }
  }
  return { buttons, runs, pending, busy, error, setPending, run, stop }
}

type State = ReturnType<typeof useTaskActions>

export function ActionRunCards({ runs, onStop }: { runs: ActionRun[]; onStop: (runId: string) => void }) {
  const { t } = useI18n()
  const statusLabel = (status: string) => ({
    preparing: t('actionShortcuts.launching'),
    running: t('actionShortcuts.running'),
    stopping: t('actionShortcuts.stopping'),
    succeeded: t('actionShortcuts.succeeded'),
    stopped: t('actionShortcuts.stopped'),
    failed: t('actionShortcuts.failed'),
    timed_out: t('actionShortcuts.timedOut'),
    interrupted: t('actionShortcuts.interrupted'),
  }[status] || t('actionShortcuts.interrupted'))
  return <>
    {[...runs].reverse().map((run) => <div key={run.run_id} className="task-action-message" style={{ alignSelf: 'stretch', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div><strong>{t('actionShortcuts.runTitle', { title: run.title })}</strong><div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>{statusLabel(run.status)} · {run.cwd}</div></div>
        {isActive(run.status) && <Button variant="ghost" className="chat-message-action" disabled={run.status === 'stopping'} onClick={() => onStop(run.run_id)}><Icon name={run.status === 'stopping' ? 'loader-circle' : 'stop'} className={run.status === 'stopping' ? 'git-spin' : undefined} size={14} />{run.status === 'stopping' ? t('actionShortcuts.stopping') : t('actionShortcuts.stop')}</Button>}
      </div>
      <pre style={{ margin: '10px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto', background: 'var(--surface)', padding: 10, borderRadius: 6 }}>{run.output || (isActive(run.status) ? t('actionShortcuts.launching') : t('actionShortcuts.noOutput'))}</pre>
      {run.exit_code !== null && <small style={{ color: 'var(--muted)' }}>{t('actionShortcuts.exitCode', { code: run.exit_code })}</small>}
    </div>)}
  </>
}

export function TaskActionMessages({ state }: { state: State }) {
  return <ActionRunCards runs={state.runs} onStop={(runId) => void state.stop(runId)} />
}

export function TaskActionButtons({ state, onFillPrompt, onSendPrompt }: { state: State; onFillPrompt?: (value: string) => void; onSendPrompt?: (value: string) => void }) {
  const { t } = useI18n()
  return <>
    {state.buttons.length > 0 && <div className="chat-quick-prompts" role="group" aria-label={t('actionShortcuts.quickButtons')} style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '0 1px 8px' }}>
      {state.buttons.map((button) => {
        const actionRunning = button.kind === 'action' && state.runs.some((run) => run.action_id === button.action_id && isActive(run.status))
        return <QuickPromptButton
          key={`${button.source}:${button.id}`}
          label={button.label}
          prompt={button.kind === 'action' ? button.id : button.prompt || ''}
          disabled={Boolean(actionRunning || (button.kind === 'action' && state.busy))}
          displayOnly={button.kind === 'display'}
          displayContent={button.content}
          onSelect={() => {
            if (button.kind === 'action') { void state.run(button); return }
            if (button.kind === 'prompt') {
              if (button.immediate_send) onSendPrompt?.(button.prompt)
              else onFillPrompt?.(button.prompt)
            }
          }}
          style={{ flexShrink: 0, borderRadius: 999, whiteSpace: 'nowrap' }}
        />
      })}
    </div>}
    {state.error && <span role="alert" style={{ color: 'var(--danger)' }}>{state.error}</span>}
    <ConfirmDialog
      open={Boolean(state.pending)} title={t('actionShortcuts.confirmTitle', { title: state.pending?.label || '' })}
      message={state.pending ? t('actionShortcuts.confirmMessage', { script: state.pending.script_path || '', directory: state.pending.cwd_mode || 'task' }) : ''}
      confirmText={t('actionShortcuts.confirm')} loading={state.busy}
      onCancel={() => state.setPending(null)}
      onConfirm={() => { if (state.pending) void state.run(state.pending, true) }}
    />
  </>
}
