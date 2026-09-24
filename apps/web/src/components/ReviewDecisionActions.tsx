import Button from './Button'
import { useI18n } from '../i18n'

export type ReviewDecisionAction = 'approve' | 'reject' | 'force-approve' | 'terminate' | 'complete-task' | 'set-complete'

interface ReviewDecisionActionsProps {
  status: string
  pending: boolean
  onAction: (decision: ReviewDecisionAction) => void
}

export default function ReviewDecisionActions({ status, pending, onAction }: ReviewDecisionActionsProps) {
  const { t } = useI18n()
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
      <Button variant="danger" disabled={pending} onClick={() => onAction('terminate')}>
        {t('taskDetail.terminate')}
      </Button>
      <Button variant="ghost" disabled={pending} style={{ marginRight: 'auto' }} onClick={() => onAction('complete-task')}>
        {t('taskDetail.completeTask')}
      </Button>
      {status === 'pending' ? (
        <>
          <Button variant="ghost" disabled={pending} onClick={() => onAction('reject')}>
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
