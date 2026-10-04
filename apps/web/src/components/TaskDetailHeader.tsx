import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import Button from './Button'
import Icon from './Icon'
import MarqueeText from './MarqueeText'
import TaskRecoveredBadge from './TaskRecoveredBadge'
import { useI18n, type TKey } from '../i18n'
import type { TaskDetailViewProps, StepData } from './TaskDetailView'

const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready', running: 'status.running', paused: 'status.paused',
  stopped: 'status.stopped', done: 'status.done',
}

interface TaskDetailHeaderProps {
  task: NonNullable<TaskDetailViewProps['task']>
  locale: string
  activeStep: StepData
  activeStepColor: string
  taskCompleted: boolean
  headerActions?: ReactNode
  taskHeaderExtra?: ReactNode
  onClose?: () => void
  onHeaderPointerDown?: (event: PointerEvent<HTMLDivElement>) => void
  onHeaderKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onHeaderDoubleClick?: () => void
}

export default function TaskDetailHeader({ task, locale, activeStep, activeStepColor,
  taskCompleted, headerActions, taskHeaderExtra, onClose, onHeaderPointerDown,
  onHeaderKeyDown, onHeaderDoubleClick }: TaskDetailHeaderProps) {
  const { t } = useI18n()
  const draggable = Boolean(onHeaderPointerDown)
  const status = taskCompleted ? 'done' : task.status
  const createdAt = new Date(task.created_at).toLocaleString(locale)
  const meta = task.creator_name ? `${t('taskDetail.creator')}：${task.creator_name} · ${createdAt}` : createdAt
  return (
    <div className={`task-detail-header${draggable ? ' task-detail-header--draggable' : ''}`}
      role={draggable ? 'group' : undefined}
      tabIndex={draggable ? 0 : undefined}
      aria-label={draggable ? t('taskDetail.dragWindowAria') : undefined}
      title={draggable ? t('taskDetail.dragWindowTitle') : undefined}
      onPointerDown={onHeaderPointerDown} onKeyDown={onHeaderKeyDown}
      onDoubleClick={onHeaderDoubleClick}>
      {draggable && <span className="task-detail-drag-handle" aria-hidden="true">⠿</span>}
      <div className="task-detail-header-main">
        <div className="task-detail-header-fields">
          <div className="task-detail-header-primary">
            <span className="task-detail-title">{task.title}</span>
            <span className="task-detail-header-badge" style={{ '--badge-color': activeStepColor } as CSSProperties}>
              {t('taskDetail.currentStep', { step: activeStep.label })}
            </span>
            <TaskRecoveredBadge status={task.status} recoveredCount={task.recovered_count}
              className="task-detail-recovered-badge" />
            <span className="task-detail-header-badge" data-status={status}>
              {t(STATUS_LABEL_KEYS[status] ?? (status as TKey))}
            </span>
          </div>
          <div className="task-detail-header-secondary">
            <span className="task-detail-header-meta"
              title={task.creator_device_name ? `${meta} · ${task.creator_device_name}` : meta}>
              <MarqueeText text={meta} forceActive />
            </span>
            {(headerActions || taskHeaderExtra) && <div className="task-detail-header-actions">
              {headerActions}
              {taskHeaderExtra}
            </div>}
          </div>
        </div>
      </div>
      {onClose && <Button variant="icon" className="task-detail-header-close"
        aria-label={t('common.close')} title={t('common.close')}
        onPointerDown={(event) => event.stopPropagation()} onClick={onClose}>
        <Icon name="x" size={16} />
      </Button>}
    </div>
  )
}
