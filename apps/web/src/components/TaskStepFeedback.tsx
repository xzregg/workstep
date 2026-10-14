import { useI18n } from '../i18n'
import MarkdownMessage from './MarkdownMessage'
import './TaskStepFeedback.css'

export default function TaskStepFeedback({ content, status }: { content: string; status?: string }) {
  const { t } = useI18n()
  const isError = status === 'failed' || status === 'cancelled'
  const title = t(isError ? 'taskDetail.stepExecutionIssue' : 'taskDetail.stepReviewFeedback')
  const long = content.length > 240 || content.split('\n').length > 4
  const heading = <span className="task-step-feedback-title">{title}</span>
  const body = <MarkdownMessage content={content} reveal="off" className="task-step-feedback-body" />

  return <div className="task-step-feedback" data-error={isError}
    role={isError ? 'alert' : 'status'}>
    {long ? <details>
      <summary>
        <span className="task-step-feedback-heading">{heading}
          <span className="task-step-feedback-expand">{t('taskDetail.expandStepFeedback')}</span>
          <span className="task-step-feedback-collapse">{t('taskDetail.collapseStepFeedback')}</span>
        </span>
        <span className="task-step-feedback-preview">{content.slice(0, 240)}…</span>
      </summary>
      {body}
    </details> : <>{heading}{body}</>}
  </div>
}
