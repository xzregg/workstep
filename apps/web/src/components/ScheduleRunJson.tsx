import type { ScheduleRun } from '../api/schedule'
import { useI18n } from '../i18n'
import './ScheduleRunJson.css'

export default function ScheduleRunJson({ run }: { run: ScheduleRun }) {
  const { t } = useI18n()
  return <details className="schedule-run-json">
    <summary>{t('schedules.generatedJson')}</summary>
    {run.generated_tasks != null
      ? <pre>{JSON.stringify(run.generated_tasks, null, 2)}</pre>
      : <p>{t('schedules.generatedJsonUnavailable')}</p>}
  </details>
}
