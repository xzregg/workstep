import { useState } from 'react'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'

interface TaskReviewConfigPanelProps {
  projectId?: string
  mode?: string
  onModeChange?: (value: string) => void
  retries?: number
  onRetriesChange?: (value: number) => void
  prompt?: string
  onPromptChange?: (value: string) => void
  onSave?: () => void
}

/** Step review settings own their disclosure state; the task page owns persistence. */
export default function TaskReviewConfigPanel({ projectId, mode, onModeChange,
  retries, onRetriesChange, prompt, onPromptChange, onSave }: TaskReviewConfigPanelProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <section className="task-review-config">
      <button className="task-review-config-toggle" type="button"
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="task-review-config-chevron" aria-hidden="true">&#9654;</span>
        {t('taskDetail.stepReviewConfig')}
      </button>
      {open && <div className="task-review-config-body">
        <div className="task-review-config-fields">
          <div className="task-review-config-modes">
            {([
              ['skip', t('flow.reviewSkip')],
              ['auto', t('flow.autoReview')],
              ['manual', t('flow.manualReview')],
            ] as const).map(([value, label]) => <button key={value} type="button"
              className="task-review-config-mode" aria-pressed={mode === value}
              onClick={() => onModeChange?.(value)}>{label}</button>)}
          </div>
          {mode === 'auto' && <div className="task-review-config-retries">
            <span>{t('flow.retry')}</span>
            <Input className="task-review-config-retry-input" type="number" min={1} max={5}
              value={retries ?? 1} onChange={(event) => onRetriesChange?.(
                Math.max(1, Math.min(5, Number(event.target.value) || 1)),
              )} />
            <span className="task-review-config-hint">{t('flow.reviewAutoRetryHint')}</span>
          </div>}
          {mode === 'skip' && <div className="task-review-config-hint">{t('flow.reviewSkipHint')}</div>}
          {mode === 'manual' && <div className="task-review-config-hint">{t('flow.reviewPauseHint')}</div>}
        </div>
        <MarkdownEditor value={prompt ?? ''} onChange={onPromptChange ?? (() => {})}
          projectId={projectId} placeholder={t('taskDetail.reviewPromptPlaceholder')}
          minHeight={64} maxHeight={160} ariaLabel={t('taskDetail.reviewPromptAria')} />
        <div className="task-review-config-actions">
          <Button variant="ghost" className="task-review-config-save" onClick={onSave}>
            {t('common.save')}
          </Button>
        </div>
      </div>}
    </section>
  )
}
