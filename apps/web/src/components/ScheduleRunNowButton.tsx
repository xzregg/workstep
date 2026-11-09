import { useRef, useState } from 'react'
import { scheduleApi } from '../api/schedule'
import { useI18n } from '../i18n'
import Button from './Button'

export default function ScheduleRunNowButton({ projectId, scheduleId, disabled, running, onStarted }: {
  projectId: string; scheduleId: string; disabled?: boolean; running: boolean; onStarted: () => void
}) {
  const { t } = useI18n()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError('')
    try {
      await scheduleApi.runNow(projectId, scheduleId)
      onStarted()
    } catch (cause) { setError((cause as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  return <>
    {error && <span className="schedule-run-now-error" role="alert">{error}</span>}
    <Button loading={busy || running} disabled={disabled} title={t('schedules.runNowHelp')} onClick={() => void run()}>{t('schedules.runNow')}</Button>
  </>
}
