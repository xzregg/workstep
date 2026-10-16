import { useState } from 'react'
import { taskApi } from '../api/client'
import { useI18n } from '../i18n'
import Button from './Button'
import './TaskScheduleEditor.css'

export default function ScheduledMessageStatus({ taskId, projectId, message, canStop }: {
  taskId: string; projectId?: string; message: { id: string; role?: string; run_status?: string; author_name?: string; schedule_run_id?: string }; canStop: boolean
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stop = async () => {
    if (!projectId) return
    setBusy(true); setError('')
    try { await taskApi.stopCoordinator(taskId, projectId, message.id) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="task-message-schedule-source" title={message.schedule_run_id}>
    {message.role === 'user' ? message.author_name || t('schedules.scheduledExecution') : t('schedules.scheduledExecution')}
    {canStop && projectId && message.role !== 'user' && ['running','queued'].includes(message.run_status || '') && <Button className="chat-message-action" size="sm" loading={busy} onClick={() => void stop()}>{t('common.stop')}</Button>}
    {error && <span role="alert">{error}</span>}
  </div>
}
