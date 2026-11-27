import { useI18n } from '../i18n'
import Button from './Button'
import Textarea from './Textarea'
import './TaskReviewCommentInput.css'

interface Props {
  value: string
  inMessage?: boolean
  onChange?: (value: string) => void
}

export default function TaskReviewCommentInput({ value, onChange, inMessage }: Props) {
  const { t } = useI18n()
  return <div className="task-review-comment">
    <div className="task-review-comment-toolbar">
      <Button type="button" variant="ghost" size="sm" className={inMessage ? 'chat-message-action' : undefined}
        onClick={() => onChange?.('')}>{t('taskDetail.clearReviewComment')}</Button>
    </div>
    <Textarea rows={2} value={value} onChange={(event) => onChange?.(event.target.value)}
      aria-label={t('taskDetail.reviewCommentPlaceholder')}
      placeholder={t('taskDetail.reviewCommentPlaceholder')} />
  </div>
}
