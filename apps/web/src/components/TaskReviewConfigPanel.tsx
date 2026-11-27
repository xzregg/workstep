import { useEffect, useMemo, useState } from 'react'
import { useI18n, localizeErrorDisplay } from '../i18n'
import { useTaskStore } from '../stores/taskStore'
import Button from './Button'
import Input from './Input'
import MarkdownEditor from './MarkdownEditor'

interface TaskReviewConfigPanelProps {
  taskId: string
  stepKey: string
  projectId: string
  workflowReview?: Record<string, any> | null
  reviewOverrides?: Record<string, any> | null
}

type ReviewMode = 'skip' | 'auto' | 'manual'

function reviewDraft(config: Record<string, any> | undefined) {
  const mode: ReviewMode = ['skip', 'auto', 'manual'].includes(config?.mode)
    ? config!.mode : config?.auto ? 'auto' : 'manual'
  return { mode, retries: String(config?.maxRetries ?? 1), prompt: config?.prompt ?? '' }
}

/** Owns the selected step's review draft, persistence, and save error. */
export default function TaskReviewConfigPanel({ taskId, stepKey, projectId,
  workflowReview, reviewOverrides }: TaskReviewConfigPanelProps) {
  const { t } = useI18n()
  const updateTaskDescription = useTaskStore((state) => state.updateTaskDescription)
  const override = reviewOverrides?.[stepKey]
  const config = useMemo(() => ({
    ...(workflowReview || { mode: 'skip' }),
    ...override,
  }), [workflowReview, override])
  const [draft, setDraft] = useState(() => reviewDraft(config))
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft(reviewDraft(config))
    setError('')
  }, [taskId, stepKey, config])

  const retries = Number(draft.retries)
  const validRetries = draft.retries.trim() !== '' && Number.isInteger(retries) && retries >= 1 && retries <= 5

  const save = async () => {
    if (saving || (draft.mode === 'auto' && !validRetries)) return
    setSaving(true)
    setError('')
    try {
      await updateTaskDescription(taskId, undefined, projectId, {
        ...(reviewOverrides || {}),
        [stepKey]: {
          mode: draft.mode,
          auto: draft.mode === 'auto',
          maxRetries: validRetries ? retries : config.maxRetries ?? 1,
          prompt: draft.prompt,
        },
      })
    } catch (reason) {
      setError(t('taskDetail.saveFailed', {
        error: reason instanceof Error ? reason.message : t('common.unknownError'),
      }))
    } finally {
      setSaving(false)
    }
  }

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
              className="task-review-config-mode" aria-pressed={draft.mode === value}
              onClick={() => setDraft((current) => ({ ...current, mode: value }))}>{label}</button>)}
          </div>
          {draft.mode === 'auto' && <div className="task-review-config-retries">
            <span>{t('flow.retry')}</span>
            <Input className="task-review-config-retry-input" type="number" min={1} max={5}
              value={draft.retries} aria-invalid={!validRetries} onChange={(event) => setDraft((current) => ({ ...current,
                retries: event.target.value,
              }))} />
            <span className="task-review-config-hint">{t('flow.reviewAutoRetryHint')}</span>
          </div>}
          {draft.mode === 'skip' && <div className="task-review-config-hint">{t('flow.reviewSkipHint')}</div>}
          {draft.mode === 'manual' && <div className="task-review-config-hint">{t('flow.reviewPauseHint')}</div>}
        </div>
        <MarkdownEditor value={draft.prompt} onChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
          projectId={projectId} placeholder={t('taskDetail.reviewPromptPlaceholder')}
          minHeight={120} maxHeight={160} ariaLabel={t('taskDetail.reviewPromptAria')} />
        {error && <div role="alert" className="task-review-config-error">{localizeErrorDisplay(error)}</div>}
        <div className="task-review-config-actions">
          <Button variant="ghost" className="task-review-config-save" loading={saving} disabled={draft.mode === 'auto' && !validRetries}
            onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </div>}
    </section>
  )
}
