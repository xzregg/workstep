import { useI18n } from '../i18n'
import Icon from './Icon'

export type TaskBoardView = 'lanes' | 'status' | 'table'

export default function TaskBoardViewToggle({ value, disabled, onChange }: {
  value: TaskBoardView
  disabled: boolean
  onChange: (value: TaskBoardView) => void
}) {
  const { t } = useI18n()
  const views = [
    { key: 'lanes', label: t('taskList.viewStepLanes'), icon: 'workflow' },
    { key: 'status', label: t('taskList.viewStatusLanes'), icon: 'layout-grid' },
    { key: 'table', label: t('taskList.viewTable'), icon: 'table' },
  ] as const
  return <div className="task-board-view-toggle" role="group" aria-label={t('taskList.viewMode')}>
    {views.map(view => <button
      key={view.key} type="button" title={view.label} aria-label={view.label}
      aria-pressed={value === view.key} disabled={disabled}
      onClick={() => onChange(view.key)}
    >
      <Icon name={view.icon} size={14} strokeWidth={1.6} />
    </button>)}
  </div>
}
