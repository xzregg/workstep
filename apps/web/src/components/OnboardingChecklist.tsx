import { useI18n, type TKey } from '../i18n'
import { useOnboardingStore } from '../stores/onboardingStore'
import { type OnboardingStep } from '../utils/onboarding'
import Button from './Button'
import Icon from './Icon'

interface Props {
  creatingWorkflow: boolean
  error: string
  onOpenProvider: () => void
  onOpenLocalAgent: () => void
  onOpenEngine: () => void
  onOpenProject: () => void
  onCreateWorkflow: () => void
  onCreateTask: () => void
}

const STEP_ORDER: OnboardingStep[] = ['provider', 'engine', 'project', 'workflow', 'task']

const COPY: Record<OnboardingStep, { title: TKey; path: TKey; description: TKey; action: TKey }> = {
  provider: { title: 'onboarding.steps.provider.title', path: 'onboarding.steps.provider.path', description: 'onboarding.steps.provider.description', action: 'onboarding.steps.provider.action' },
  engine: { title: 'onboarding.steps.engine.title', path: 'onboarding.steps.engine.path', description: 'onboarding.steps.engine.description', action: 'onboarding.steps.engine.action' },
  project: { title: 'onboarding.steps.project.title', path: 'onboarding.steps.project.path', description: 'onboarding.steps.project.description', action: 'onboarding.steps.project.action' },
  workflow: { title: 'onboarding.steps.workflow.title', path: 'onboarding.steps.workflow.path', description: 'onboarding.steps.workflow.description', action: 'onboarding.steps.workflow.action' },
  task: { title: 'onboarding.steps.task.title', path: 'onboarding.steps.task.path', description: 'onboarding.steps.task.description', action: 'onboarding.steps.task.action' },
}

export default function OnboardingChecklist({
  creatingWorkflow,
  error,
  onOpenProvider,
  onOpenLocalAgent,
  onOpenEngine,
  onOpenProject,
  onCreateWorkflow,
  onCreateTask,
}: Props) {
  const { t } = useI18n()
  const state = useOnboardingStore()
  const completed = Object.fromEntries(
    STEP_ORDER.map((step) => [step, state.completedSteps.includes(step)]),
  ) as Record<OnboardingStep, boolean>
  const completedCount = STEP_ORDER.filter((step) => completed[step]).length
  const currentStep = STEP_ORDER.find((step) => !completed[step]) ?? 'task'
  const actions: Record<OnboardingStep, () => void> = {
    provider: onOpenProvider,
    engine: onOpenEngine,
    project: onOpenProject,
    workflow: onCreateWorkflow,
    task: onCreateTask,
  }
  const runAction = (step: OnboardingStep, action: () => void) => {
    action()
    state.completeStep(step)
  }

  if (state.status === 'dismissed' || state.status === 'completed') return null

  if (state.collapsed) {
    return (
      <button className="onboarding-launcher" onClick={() => state.setCollapsed(false)}>
        <Icon name="sparkles" size={15} strokeWidth={2} />
        <span>{t('onboarding.checklistTitle')}</span>
        <span className="onboarding-launcher-progress">{completedCount}/{STEP_ORDER.length}</span>
      </button>
    )
  }

  return (
    <section className="onboarding-checklist" role="region" aria-label={t('onboarding.checklistTitle')}>
      <div className="onboarding-checklist-header">
        <div>
          <h2>{t('onboarding.checklistTitle')}</h2>
          <span>{t('onboarding.progress', { completed: completedCount, total: STEP_ORDER.length })}</span>
        </div>
        <div className="onboarding-checklist-actions">
          <Button variant="icon" aria-label={t('onboarding.collapse')} title={t('onboarding.collapse')} onClick={() => state.setCollapsed(true)} style={{ width: 28, height: 28, padding: 0 }}>
            <Icon name="chevron-down" size={15} />
          </Button>
          <Button variant="ghost" onClick={state.skip} style={{ minHeight: 28, padding: '0 6px', fontSize: 'calc(11px * var(--font-scale))' }}>
            {t('onboarding.skipAll')}
          </Button>
        </div>
      </div>
      <div className="onboarding-progress-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${completedCount / STEP_ORDER.length})` }} />
      </div>

      <div className="onboarding-step-list">
        {STEP_ORDER.map((step, index) => {
          const done = completed[step]
          const active = step === currentStep
          return (
            <div key={step} className={`onboarding-step${done ? ' is-complete' : ''}${active ? ' is-active' : ''}`}>
              <span className="onboarding-step-marker" aria-hidden="true">
                {done ? <Icon name="check" size={13} strokeWidth={2.5} /> : index + 1}
              </span>
              <div className="onboarding-step-copy">
                <strong>{t(COPY[step].title)}</strong>
                {active && <div className="onboarding-step-path">{t(COPY[step].path)}</div>}
                {active && <p>{t(COPY[step].description)}</p>}
                {active && error && <div className="onboarding-step-error" role="status">{error}</div>}
                {active && (
                  step === 'provider' ? (
                    <div className="onboarding-setup-actions">
                      <Button
                        variant="primary"
                        onClick={() => runAction('provider', onOpenProvider)}
                      >
                        {t(COPY.provider.action)}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => runAction('provider', onOpenLocalAgent)}
                      >
                        {t('onboarding.steps.provider.localAction')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      loading={step === 'workflow' && creatingWorkflow}
                      disabled={step === 'workflow' && creatingWorkflow}
                      onClick={() => runAction(step, actions[step])}
                    >
                      {step === 'workflow' && creatingWorkflow ? t('onboarding.createWorkflowBusy') : t(COPY[step].action)}
                    </Button>
                  )
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
