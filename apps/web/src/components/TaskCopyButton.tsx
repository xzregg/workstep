import { useRef, useState } from 'react'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useTaskStore } from '../stores/taskStore'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import './TaskCopyButton.css'

export default function TaskCopyButton({ taskId, projectId, title, presentation = 'icon', onCopied, disabled = false, onBusyChange }: { taskId: string; projectId: string; title: string; presentation?: 'icon' | 'menu' | 'toolbar'; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onCopied?: () => void }) {
  const { can } = useGatewayProjectPermissions(projectId)
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  if (!can('task.copy')) return null
  async function copy() {
    if (!can('task.copy') || disabled || busyRef.current) return
    busyRef.current = true
    onBusyChange?.(true)
    setBusy(true); setError('')
    try {
      await useTaskStore.getState().copyTask(taskId, t('taskList.copyTitle', { title }), projectId)
      onCopied?.()
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { busyRef.current = false; setBusy(false); onBusyChange?.(false) }
  }
  if (presentation === 'menu' || presentation === 'toolbar') return <>
    <Button data-task-action="copy" aria-label={t('taskList.copyTask')} loading={busy} disabled={disabled || busy} onClick={() => void copy()}>
      <Icon name="copy" size={16} />{t(presentation === 'toolbar' ? 'common.copy' : 'taskList.copyTask')}
    </Button>
    {error && <span className="task-copy-error" role="alert">{localizeErrorDisplay(error)}</span>}
  </>
  return <span className="task-copy-control" onClick={event => event.stopPropagation()}>
    <Button variant="icon" className="task-board-card-icon" data-task-action="copy" aria-label={t('taskList.copyTask')}
      title={t('taskList.copyTask')} loading={busy} disabled={disabled || busy} onClick={() => void copy()}><Icon name="copy" size={12} /></Button>
    {error && <span className="task-copy-error" role="alert">{localizeErrorDisplay(error)}</span>}
  </span>
}
