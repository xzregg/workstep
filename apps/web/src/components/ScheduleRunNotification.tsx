import { useState } from 'react'
import { scheduleApi, type ScheduleRun } from '../api/schedule'
import { useI18n } from '../i18n'
import Button from './Button'
import './ScheduleNotificationEditor.css'

export default function ScheduleRunNotification({ projectId, scheduleId, run, onRetried, canRetry = true }: {
  projectId: string; scheduleId: string; run: ScheduleRun; canRetry?: boolean; onRetried: () => void | Promise<void>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!run.notification_status || run.notification_status === 'disabled') return null
  const retry = async () => {
    setBusy(true); setError('')
    try { await scheduleApi.retryNotification(projectId, scheduleId, run.id); await onRetried() }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="schedule-notification-run">
    {run.notification_status === 'sending' && <span className="task-status-spinner" />}
    <span>{t(`schedules.notification_${run.notification_status}`)}{run.notification_error && `：${run.notification_error}`}</span>
    {canRetry && run.notification_status === 'failed' && <Button size="sm" loading={busy} onClick={() => void retry()}>{t('schedules.notificationRetry')}</Button>}
    {error && <span role="alert">{error}</span>}
  </div>
}
