import { useI18n } from '../i18n'

export interface TaskRecoveredBadgeProps {
  status?: string | null
  recoveredCount?: number | null
  className?: string
}

export default function TaskRecoveredBadge({
  status,
  recoveredCount,
  className = '',
}: TaskRecoveredBadgeProps) {
  const { t } = useI18n()

  if (status !== 'running' || !recoveredCount) return null

  return (
    <span
      className={['task-recovered-badge', className].filter(Boolean).join(' ')}
      title={t('taskList.recoveredTitle', { count: recoveredCount })}
    >
      {t('taskList.recovered')}
    </span>
  )
}
