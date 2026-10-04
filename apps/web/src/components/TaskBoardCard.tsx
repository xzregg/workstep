import type { CSSProperties, DragEvent as ReactDragEvent } from 'react'
import type { Task } from '../api/client'
import { useI18n, type TKey } from '../i18n'
import { isTaskCompleted, isTaskNotStarted } from '../pages/taskDetailChat'
import { formatDuration, toMilliseconds } from '../utils/datetime'
import { formatScheduledStart } from '../utils/scheduledStart'
import { formatTokenTotal } from '../utils/statistics'
import Button from './Button'
import Icon from './Icon'
import MarqueeText from './MarqueeText'
import TaskRecoveredBadge from './TaskRecoveredBadge'

const STATUS_LABEL_KEYS: Record<string, TKey> = {
  ready: 'status.ready', running: 'status.running', paused: 'status.paused', stopped: 'status.stopped',
  queued: 'status.queued',
  done: 'status.done',
  reviewing: 'status.reviewing', awaiting_review: 'status.awaiting_review',
  retrying: 'status.retrying', rejected: 'status.rejected',
  cancelled: 'status.cancelled',
  rework: 'status.rework', rework_waiting: 'status.rework_waiting',
}

const STATUS_COLORS: Record<string, string> = {
  ready: 'var(--status-ready)',
  running: 'var(--status-running)',
  paused: 'var(--status-paused)',
  stopped: 'var(--status-stopped)',
  queued: '#a16207',
  done: 'var(--status-done)',
  passed: 'var(--status-done)',
  failed: 'var(--status-failed)',
  reviewing: 'var(--accent)',
  awaiting_review: 'var(--status-paused)',
  retrying: 'var(--warn)',
  rejected: 'var(--status-failed)',
  cancelled: '#d97706',
  rework: 'var(--warn)',
  rework_waiting: 'var(--warn)',
}

interface Props {
  task: Task
  durationNowMs: number
  showArchived: boolean
  starting: boolean
  dragging?: boolean
  readOnly?: boolean
  onOpen: () => void
  onStart: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragEnd: (event: ReactDragEvent<HTMLDivElement>) => void
}

/** One task board card owns its status, metadata, and action presentation. */
export default function TaskBoardCard({
  task, durationNowMs, showArchived, starting, dragging = false, readOnly = false,
  onOpen, onStart, onArchive, onRestore, onDelete, onDragStart, onDragEnd,
}: Props) {
  const { t, locale } = useI18n()
  const status = task.status || 'ready'
  const taskNotStarted = isTaskNotStarted(task.steps || [])
  const taskCompleted = isTaskCompleted(task.steps || [])
  const stepStatus = ['reviewing', 'awaiting_review', 'retrying', 'rejected']
    .find((candidate) =>
      (task.steps || []).some((step: any) => step.status === candidate)
    )
  const displayStatus = taskCompleted ? 'done' : stepStatus || status
  const statusColor = STATUS_COLORS[displayStatus] || 'var(--status-ready)'
  const isRunning = status === 'running'
  const startedMs = toMilliseconds(task.first_message_at)
  const createdMs = toMilliseconds(task.created_at)
  let cardDurationMs: number | null = null
  if (isRunning) {
    const startMs = startedMs ?? createdMs
    if (startMs !== null) cardDurationMs = Math.max(0, durationNowMs - startMs)
  } else if (task.duration_ms != null) {
    cardDurationMs = task.duration_ms
  } else if (startedMs !== null) {
    const endMs = toMilliseconds(task.updated_at) ?? durationNowMs
    cardDurationMs = Math.max(0, endMs - startedMs)
  }
  const cardMetaText = [
    task.creator_name ? task.creator_name : '',
    (task.total_tokens ?? 0) > 0
      ? `${formatTokenTotal(task.total_tokens as number, locale)} ${t('taskList.tokens')}`
      : '',
    cardDurationMs !== null && cardDurationMs > 0
      ? `${t('taskList.duration')} ${formatDuration(cardDurationMs, t)}`
      : '',
  ].filter(Boolean).join(' · ')
  return (
    <div
      className="task-board-card"
      data-task-status={status}
      data-dragging={dragging || undefined}
      draggable={!readOnly && !showArchived}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={{ '--task-card-status-color': statusColor } as CSSProperties}
    >
      <div className="task-board-card-heading">
        <MarqueeText
          text={task.title}
          className="task-board-card-title"
        />
        {task.scheduled_start_state === 'pending' && task.scheduled_start_at && (
          <span
            className="status-badge task-board-card-scheduled"
            title={t('taskList.scheduledStartPending')}
          >
            <Icon name="clock" size={11} strokeWidth={2} />
            {formatScheduledStart(task.scheduled_start_at)}
          </span>
        )}
        {task.scheduled_start_state === 'missed' && (
          <span className="status-badge task-board-card-schedule-missed" title={task.scheduled_start_error || undefined}>
            {t('taskList.scheduledStartMissed')}
          </span>
        )}
        {task.scheduled_start_state === 'failed' && (
          <span className="status-badge task-board-card-schedule-failed" title={task.scheduled_start_error || undefined}>
            {t('taskList.scheduledStartFailed')}
          </span>
        )}
        <TaskRecoveredBadge
          status={status}
          recoveredCount={task.recovered_count}
          className="task-card-recovered-badge"
        />
        <span
          className="status-badge task-card-status-badge"
          data-s={displayStatus}
          data-step-status={stepStatus ? 'true' : undefined}
        >
          {(displayStatus === 'running' || displayStatus === 'reviewing') && (
            <span className="task-status-spinner" aria-hidden="true" />
          )}
          {t(STATUS_LABEL_KEYS[displayStatus] ?? (displayStatus as TKey))}
          {status === 'queued' && task.queue_position != null && task.queue_position > 0 && (
            <span className="task-board-card-queue-position">{` #${task.queue_position}`}</span>
          )}
        </span>
      </div>
      {task.description && (
        <div className="task-board-card-description">
          {task.description}
        </div>
      )}
      <div className="card-actions task-board-card-actions">
        {cardMetaText ? (
          <MarqueeText className="task-card-meta" text={cardMetaText}
            title={cardMetaText} forceActive />
        ) : (
          <span className="task-board-card-meta-spacer" />
        )}
        <div className="card-action-buttons task-board-card-buttons">
          {!readOnly && taskNotStarted && status !== 'running' && (
            <Button variant="icon" data-task-action="start"
              title={t('taskList.startTask')} aria-label={t('taskList.startTask')}
              disabled={starting} loading={starting}
              onClick={(e) => { e.stopPropagation(); onStart() }}
              className="task-board-card-icon task-board-card-icon--success">
              ▶️
            </Button>
          )}
          <Button variant="icon" className="task-board-card-icon" title={t('common.edit')}
            onClick={(e) => { e.stopPropagation(); onOpen() }}>
            <Icon name="pencil" size={12} strokeWidth={2} />
          </Button>
          {!readOnly && !showArchived && status !== 'running' && (
            <Button variant="icon" data-task-action="archive"
              title={t('taskList.archiveTask')} aria-label={t('taskList.archiveTask')}
              onClick={(e) => { e.stopPropagation(); onArchive() }}
              className="task-board-card-icon task-board-card-icon--muted">
              <Icon name="archive" size={12} strokeWidth={2} />
            </Button>
          )}
          {!readOnly && showArchived && (
            <Button variant="icon" title={t('taskList.restoreToBoard')}
              aria-label={t('taskList.restoreToBoard')}
              onClick={(e) => { e.stopPropagation(); onRestore() }}
              className="task-board-card-icon task-board-card-icon--success">
              <Icon name="rotate-ccw" size={12} strokeWidth={2} />
            </Button>
          )}
          {!readOnly && !isRunning && (
            <Button variant="icon" className="task-board-card-icon task-board-card-icon--danger"
              data-task-action="delete" title={t('common.delete')}
              onClick={(e) => { e.stopPropagation(); onDelete() }}>
              <Icon name="x" size={12} strokeWidth={2} />
            </Button>
          )}
        </div>
      </div>
      {status === 'running' && (
        <div className="card-progress">
          <span className="card-progress-fill" />
        </div>
      )}
    </div>
  )
}
