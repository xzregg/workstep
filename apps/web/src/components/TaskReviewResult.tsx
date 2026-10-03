import type { Ref } from 'react'
import type { ReviewRun } from '../api/client'
import { useI18n } from '../i18n'
import { reviewActorLabel } from '../pages/taskReviewRules'
import ReviewReportContent from './ReviewReportContent'
import ReviewDecisionActions, { type ReviewDecisionAction } from './ReviewDecisionActions'
import Textarea from './Textarea'

interface TaskReviewResultProps {
  review: ReviewRun
  projectId?: string
  actionable: boolean
  canCompleteStep?: boolean
  pending?: boolean
  comment?: string
  onCommentChange?: (value: string) => void
  onAction?: (action: ReviewDecisionAction) => void
  containerRef?: Ref<HTMLDivElement>
}

export default function TaskReviewResult({ review, projectId, actionable, pending,
  comment, onCommentChange, onAction, containerRef, canCompleteStep }: TaskReviewResultProps) {
  const { t } = useI18n()
  const actor = review.decision ? reviewActorLabel(review) : undefined
  const status = review.status === 'passed' ? 'passed'
    : review.status === 'rejected' ? 'failed' : 'paused'
  const statusLabel = review.status === 'passed' ? t('taskDetail.reviewPassed')
    : review.status === 'rejected' ? t('taskDetail.reviewRejected')
      : review.status === 'terminated' ? t('taskDetail.reviewTerminated')
        : review.status === 'running' ? t('taskDetail.reviewRunning')
          : t('taskDetail.reviewWaiting')
  return <section className="task-review-result" ref={containerRef}>
    <div className="task-review-result-heading">{t('taskDetail.reviewResult')}</div>
    <div className="task-review-result-card">
      <div className="task-review-result-summary">
        <strong>{review.mode === 'auto' ? t('taskDetail.autoReview') : t('taskDetail.manualReview')}</strong>
        <span className="status-badge" data-s={status}>{statusLabel}</span>
      </div>
      {review.report && <ReviewReportContent
        scoreLabel={review.report.score !== null
          ? t('taskDetail.scorePoints', { score: review.report.score }) : ''}
        report={review.report} projectId={projectId} />}
      {actor && <div className="task-review-result-actor">
        {t('taskDetail.reviewedBy', { name: actor })}
      </div>}
      {onAction && actionable && <>
        <Textarea rows={2} value={comment ?? ''}
          onChange={(event) => onCommentChange?.(event.target.value)}
          placeholder={t('taskDetail.reviewCommentPlaceholder')} />
        <ReviewDecisionActions canCompleteStep={canCompleteStep} status={review.status} pending={!!pending} onAction={onAction} />
      </>}
    </div>
  </section>
}
