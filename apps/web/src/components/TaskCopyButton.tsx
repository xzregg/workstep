import { useState } from 'react'
import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useTaskStore } from '../stores/taskStore'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import './TaskCopyButton.css'

export default function TaskCopyButton({ taskId, projectId, title, presentation = 'icon', onCopied }: { taskId: string; projectId: string; title: string; presentation?: 'icon' | 'menu'; onCopied?: () => void }) {
  const { can } = useGatewayProjectPermissions(projectId)
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!can('task.copy')) return null
  async function copy() {
    if (!can('task.copy') || busy) return
    setBusy(true); setError('')
    try {
      await useTaskStore.getState().copyTask(taskId, t('taskList.copyTitle', { title }), projectId)
      onCopied?.()
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  if (presentation === 'menu') return <>
    <Button data-task-action="copy" loading={busy} disabled={busy} onClick={() => void copy()}>
      <Icon name="copy" size={16} />{t('taskList.copyTask')}
    </Button>
    {error && <span className="task-copy-error" role="alert">{error}</span>}
  </>
  return <span className="task-copy-control" onClick={event => event.stopPropagation()}>
    <Button variant="icon" className="task-board-card-icon" data-task-action="copy" aria-label={t('taskList.copyTask')}
      title={t('taskList.copyTask')} loading={busy} disabled={busy} onClick={() => void copy()}><Icon name="copy" size={12} /></Button>
    {error && <span className="task-copy-error" role="alert">{error}</span>}
  </span>
}
