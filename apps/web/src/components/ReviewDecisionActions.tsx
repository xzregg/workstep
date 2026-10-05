import Button from './Button'
import { useI18n } from '../i18n'

export type ReviewDecisionAction = 'approve' | 'reject' | 'force-approve' | 'terminate' | 'complete-task' | 'set-complete'

interface ReviewDecisionActionsProps {
  canCompleteStep?: boolean
  status: string
  pending: boolean
  onAction: (decision: ReviewDecisionAction) => void
}

export default function ReviewDecisionActions({ status, pending, onAction, canCompleteStep = true }: ReviewDecisionActionsProps) {
  const { t } = useI18n()
  return (
    <div className="review-decision-actions">
      <Button variant="danger" disabled={pending} onClick={() => onAction('terminate')}>
        {t('taskDetail.terminate')}
      </Button>
      {canCompleteStep && <Button variant="ghost" disabled={pending} className="review-decision-complete" onClick={() => onAction('set-complete')}>
        {t('taskDetail.setStepComplete')}
      </Button>}
      {status === 'pending' ? (
        <>
          <Button variant="ghost" disabled={pending} className="review-decision-reject" onClick={() => onAction('reject')}>
            {t('taskDetail.reject')}
          </Button>
          <Button variant="primary" disabled={pending} loading={pending} onClick={() => onAction('approve')}>
            {t('taskDetail.approve')}
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={pending} loading={pending} onClick={() => onAction('force-approve')}>
          {t('taskDetail.forceApprove')}
        </Button>
      )}
    </div>
  )
}
