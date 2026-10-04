import type { CSSProperties } from 'react'
import { useI18n, type TKey } from '../i18n'
import { isStepResumableWithMessage } from '../pages/taskDetailChat'

interface TargetStep { key: string; label: string; color?: string }
interface StepStatus { step_key?: string; status?: string | null; has_history?: boolean }

interface Props {
  target?: string
  steps: TargetStep[]
  stepProgress: StepStatus[]
  runningStepKeys: string[]
  resumableTarget: Pick<TargetStep, 'key' | 'label'> | null
  onSelect?: (target: string) => void
}

function titleKey(status: string | null, running: boolean): TKey {
  if (running || status === 'passed' || status === 'skipped') return 'taskDetail.stepTabTitle'
  if (status === 'pending') return 'taskDetail.pendingStepTabTitle'
  if (status === 'failed' || status === 'rejected') return 'taskDetail.failedStepTabTitle'
  if (status === 'awaiting_review') return 'taskDetail.reviewWaitingStepTabTitle'
  return 'taskDetail.stoppedStepTabTitle'
}

function hintKey(status: string | null): TKey {
  if (status === 'failed' || status === 'rejected') return 'taskDetail.failedStepHint'
  if (status === 'awaiting_review') return 'taskDetail.reviewWaitingStepHint'
  if (status === 'pending') return 'taskDetail.pendingStepHint'
  return 'taskDetail.stoppedStepHint'
}

/** Chooses the recipient of a task message and explains resumable step states. */
export default function TaskChatTargetTabs({ target, steps, stepProgress, runningStepKeys,
  resumableTarget, onSelect }: Props) {
  const { t } = useI18n()
  const statusOf = (key: string): string | null => {
    const progress = stepProgress.find((item) => item.step_key === key)
    return isStepResumableWithMessage(progress?.status ?? undefined, progress?.has_history)
      ? progress?.status ?? null : null
  }
  const resumableStatus = resumableTarget ? statusOf(resumableTarget.key) : null

  return <div className="task-chat-target-picker">
    <div className="step-target-tabs">
      <button type="button" className="task-chat-coordinator-tab"
        onClick={() => onSelect?.('coordinator')}
        aria-pressed={target === 'coordinator'}
        title={t('taskDetail.coordinatorTabTitle')}>
        {t('aiFlow.agent')}
      </button>
      {steps.map((step) => <button key={step.key} type="button"
        className="task-chat-step-tab"
        onClick={() => onSelect?.(step.key)}
        aria-pressed={target === step.key}
        title={t(titleKey(statusOf(step.key), runningStepKeys.includes(step.key)), { step: step.label })}
        style={{ '--step-color': step.color || 'var(--accent)' } as CSSProperties}>
        {step.label}
      </button>)}
    </div>
    {resumableTarget && resumableStatus !== 'passed' && resumableStatus !== 'skipped' &&
      <span className="task-chat-target-hint">
        {t(hintKey(resumableStatus), { step: resumableTarget.label })}
      </span>}
    {!resumableTarget && target !== 'coordinator' && runningStepKeys.length === 0 &&
      <span className="task-chat-target-hint">{t('taskDetail.stepNotRunningHint')}</span>}
  </div>
}
