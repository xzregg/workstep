import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { engineApi, providerApi, taskApi } from '../api/client'
import { useI18n, type TKey } from '../i18n'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useProjectStore } from '../stores/projectStore'
import { isEngineReady, isProviderReady, type OnboardingStep } from '../utils/onboarding'
import Button from './Button'
import Icon from './Icon'

interface Props {
  refreshToken: number
  creatingWorkflow: boolean
  error: string
  onOpenProvider: () => void
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
  refreshToken,
  creatingWorkflow,
  error,
  onOpenProvider,
  onOpenEngine,
  onOpenProject,
  onCreateWorkflow,
  onCreateTask,
}: Props) {
  const { t } = useI18n()
  const state = useOnboardingStore()
  const projects = useProjectStore((value) => value.projects)
  const fetchProjects = useProjectStore((value) => value.fetchProjects)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (state.status === 'dismissed' || state.status === 'completed' || checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    try {
      const [providerResult, engineResult, execution] = await Promise.all([
        providerApi.list(),
        engineApi.list(),
        engineApi.executionConfig(),
        fetchProjects(),
      ])
      const latest = useOnboardingStore.getState()
      const readyProviders = providerResult.providers.filter((provider) =>
        isProviderReady(provider, providerResult.types.find((type) => type.id === provider.type)),
      )
      const provider = readyProviders.find((item) => item.id === latest.providerId) ?? readyProviders[0]
      if (!provider) {
        if (latest.providerId || latest.status === 'completed') latest.rollback('provider')
        return
      }
      if (latest.providerId !== provider.id) latest.recordProvider(provider.id)

      const engine = engineResult.engines.find((item) => isEngineReady(item, execution))
      if (!engine) {
        if (latest.engineId || latest.status === 'completed') latest.rollback('engine')
        return
      }
      if (latest.engineId !== engine.id) latest.recordEngine(engine.id)

      const current = useOnboardingStore.getState()
      const currentProjects = useProjectStore.getState().projects
      const project = currentProjects.find((item) => item.id === current.projectId && item.type !== 'remote')
      if (current.projectId && !project) {
        current.rollback('project')
        return
      }
      if (!project) return

      const workflow = project.workflows?.find((item) => item.id === current.workflowId && !item.deleted)
      if (current.workflowId && !workflow) {
        current.rollback('workflow')
        return
      }
      if (!workflow) return

      if (current.taskId) {
        try {
          await taskApi.get(current.taskId, project.id)
        } catch {
          useOnboardingStore.getState().rollback('task')
        }
      }
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }, [state.status, fetchProjects])

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, refreshToken, state.currentStep])

  const completed = useMemo<Record<OnboardingStep, boolean>>(() => {
    const project = projects.find((item) => item.id === state.projectId && item.type !== 'remote')
    const workflow = project?.workflows?.find((item) => item.id === state.workflowId && !item.deleted)
    return {
      provider: Boolean(state.providerId),
      engine: Boolean(state.providerId && state.engineId),
      project: Boolean(project),
      workflow: Boolean(project && workflow),
      task: Boolean(project && workflow && state.taskId),
    }
  }, [projects, state.providerId, state.engineId, state.projectId, state.workflowId, state.taskId])
  const completedCount = STEP_ORDER.filter((step) => completed[step]).length
  const currentStep = STEP_ORDER.find((step) => !completed[step]) ?? 'task'
  const actions: Record<OnboardingStep, () => void> = {
    provider: onOpenProvider,
    engine: onOpenEngine,
    project: onOpenProject,
    workflow: onCreateWorkflow,
    task: onCreateTask,
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
          <Button variant="icon" aria-label={t('onboarding.dismiss')} title={t('onboarding.dismiss')} onClick={state.dismiss} style={{ width: 28, height: 28, padding: 0 }}>
            <Icon name="x" size={14} />
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
                  <Button
                    variant="primary"
                    loading={step === 'workflow' && creatingWorkflow}
                    disabled={checking || (step === 'workflow' && creatingWorkflow)}
                    onClick={actions[step]}
                  >
                    {step === 'workflow' && creatingWorkflow ? t('onboarding.createWorkflowBusy') : t(COPY[step].action)}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
