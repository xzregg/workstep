import type { ReactNode } from 'react'
import { useI18n } from '../i18n'
import Button from './Button'
import Icon from './Icon'
import MarkdownEditor from './MarkdownEditor'
import MarkdownMessage from './MarkdownMessage'

interface TaskDetailDescriptionProps {
  taskId: string
  description?: string | null
  projectId?: string
  scheduledStartText?: string
  editing?: boolean
  draft?: string
  onDraftChange?: (value: string) => void
  saving?: boolean
  error?: string
  onSave?: () => void
  onCancel?: () => void
  onOpenEditor?: () => void
  leadingActions?: ReactNode
}

export default function TaskDetailDescription({ taskId, description, projectId,
  scheduledStartText, editing, draft, onDraftChange, saving, error, onSave,
  onCancel, onOpenEditor, leadingActions }: TaskDetailDescriptionProps) {
  const { t } = useI18n()
  return (
    <section className="task-detail-description">
      <div className="task-description-header">
        <div className="task-description-heading">
          <span className="task-description-label">{t('taskDetail.description')}</span>
          {scheduledStartText && <span className="task-description-schedule">
            <Icon name="clock" size={11} strokeWidth={2} />{scheduledStartText}
          </span>}
        </div>
        {onOpenEditor && !editing && <Button variant="ghost"
          className="task-description-edit" aria-label={t('taskDetail.editDescriptionAria')}
          onClick={onOpenEditor}>
          <span aria-hidden="true">✎</span>{t('common.edit')}
        </Button>}
      </div>
      {editing ? <div>
        <MarkdownEditor value={draft ?? ''} onChange={onDraftChange ?? (() => {})}
          projectId={projectId} imagePrefix={taskId.slice(0, 8)}
          placeholder={t('taskDetail.descriptionPlaceholder')}
          minHeight={140} maxHeight="33vh" disabled={saving} autoFocus />
        {error && <div className="task-description-error" role="alert">{error}</div>}
        <div className="task-description-actions">
          {leadingActions && <div className="task-description-leading-actions">{leadingActions}</div>}
          <Button variant="ghost" disabled={saving} onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={saving} loading={saving} onClick={onSave}>{t('common.save')}</Button>
        </div>
      </div> : <div className="task-description-content">
        {description ? <MarkdownMessage content={description} projectId={projectId} />
          : <span className="task-description-empty">{t('taskDetail.noDescription')}</span>}
      </div>}
    </section>
  )
}
