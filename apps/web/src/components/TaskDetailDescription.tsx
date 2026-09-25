import { useState } from 'react'
import type { TaskStepState } from '../api/client'
import { useI18n } from '../i18n'
import { isTaskNotStarted } from '../pages/taskDetailChat'
import { useTaskStore } from '../stores/taskStore'
import {
  formatScheduledStart, localDateTimeAfter, localDateTimeToIso, utcToLocalDateTime,
} from '../utils/scheduledStart'
import Button from './Button'
import DateTimePicker from './DateTimePicker'
import Icon from './Icon'
import MarkdownEditor from './MarkdownEditor'
import MarkdownMessage from './MarkdownMessage'

interface DescriptionTask {
  id: string
  description?: string | null
  steps: TaskStepState[]
  scheduled_start_at?: string | null
  scheduled_start_state?: string | null
}

interface TaskDetailDescriptionProps {
  task: DescriptionTask
  projectId?: string
  editable?: boolean
}

/** Owns description editing and the scheduled start adjustment shown beside it. */
export default function TaskDetailDescription({ task, projectId, editable = false }: TaskDetailDescriptionProps) {
  const { t } = useI18n()
  const updateDescription = useTaskStore((state) => state.updateTaskDescription)
  const updateScheduledStart = useTaskStore((state) => state.updateScheduledStart)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [scheduledDraft, setScheduledDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const canReschedule = Boolean(task.scheduled_start_state) && isTaskNotStarted(task.steps)

  const openEditor = () => {
    setDraft(task.description || '')
    setScheduledDraft('')
    setError('')
    setEditing(true)
  }

  const save = async () => {
    if (!projectId || saving) return
    setSaving(true)
    setError('')
    try {
      await updateDescription(task.id, draft, projectId)
      if (scheduledDraft) {
        const scheduledStartAt = localDateTimeToIso(scheduledDraft)
        if (scheduledStartAt) await updateScheduledStart(task.id, scheduledStartAt, projectId)
      }
      setScheduledDraft('')
      setEditing(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('taskDetail.descriptionSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return <section className="task-detail-description">
    <div className="task-description-header">
      <div className="task-description-heading">
        <span className="task-description-label">{t('taskDetail.description')}</span>
        {task.scheduled_start_at && <span className="task-description-schedule">
          <Icon name="clock" size={11} strokeWidth={2} />{formatScheduledStart(task.scheduled_start_at)}
        </span>}
      </div>
      {editable && !editing && <Button variant="ghost"
        className="task-description-edit" aria-label={t('taskDetail.editDescriptionAria')}
        onClick={openEditor}>
        <span aria-hidden="true">✎</span>{t('common.edit')}
      </Button>}
    </div>
    {editing ? <div>
      <MarkdownEditor value={draft} onChange={setDraft}
        projectId={projectId} imagePrefix={task.id.slice(0, 8)}
        placeholder={t('taskDetail.descriptionPlaceholder')}
        minHeight={140} maxHeight="33vh" disabled={saving} autoFocus />
      {error && <div className="task-description-error" role="alert">{error}</div>}
      <div className="task-description-actions">
        {canReschedule && <div className="task-description-leading-actions">
          <div className="task-description-schedule-editor">
            <span className="task-description-schedule-status" data-state={task.scheduled_start_state}>
              {task.scheduled_start_state === 'pending'
                ? t('taskList.scheduledStartPending')
                : task.scheduled_start_state === 'failed'
                  ? t('taskList.scheduledStartFailed')
                  : t('taskList.scheduledStartMissed')}
            </span>
            <div className="task-description-schedule-picker">
              <DateTimePicker
                value={scheduledDraft || utcToLocalDateTime(task.scheduled_start_at)}
                min={localDateTimeAfter(1)}
                onChange={setScheduledDraft}
                disabled={saving}
              />
            </div>
          </div>
        </div>}
        <Button variant="ghost" disabled={saving} onClick={() => {
          setScheduledDraft('')
          setEditing(false)
        }}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={saving} loading={saving} onClick={() => void save()}>{t('common.save')}</Button>
      </div>
    </div> : <div className="task-description-content">
      {task.description ? <MarkdownMessage content={task.description} projectId={projectId} />
        : <span className="task-description-empty">{t('taskDetail.noDescription')}</span>}
    </div>}
  </section>
}
