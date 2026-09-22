import { create } from 'zustand'
import {
  DEFAULT_ONBOARDING_STATE,
  loadOnboardingState,
  saveOnboardingState,
  type OnboardingState,
  type OnboardingSetupMode,
  type OnboardingStep,
} from '../utils/onboarding'

interface OnboardingStore extends OnboardingState {
  start: () => void
  reopen: () => void
  dismiss: () => void
  skip: () => void
  completeStep: (step: OnboardingStep) => void
  setCollapsed: (collapsed: boolean) => void
  chooseSetupMode: (mode: OnboardingSetupMode) => void
  recordProvider: (providerId: string) => void
  recordEngine: (engineId: string) => void
  recordProject: (projectId: string) => void
  recordWorkflow: (workflowId: string) => void
  recordTask: (taskId: string) => void
  setCurrentStep: (step: OnboardingStep) => void
  rollback: (step: OnboardingStep) => void
  markCanvasHintSeen: () => void
}

const persist = (state: OnboardingState) => {
  saveOnboardingState(state)
  return state
}

const stepOrder: OnboardingStep[] = ['provider', 'engine', 'project', 'workflow', 'task']

const snapshot = (state: OnboardingStore): OnboardingState => ({
  status: state.status,
  currentStep: state.currentStep,
  collapsed: state.collapsed,
  setupMode: state.setupMode,
  providerId: state.providerId,
  engineId: state.engineId,
  projectId: state.projectId,
  workflowId: state.workflowId,
  taskId: state.taskId,
  canvasHintSeen: state.canvasHintSeen,
  completedSteps: state.completedSteps,
})

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  ...loadOnboardingState(),
  start: () => set((current) => persist({
    ...snapshot(current),
    status: 'active',
    collapsed: false,
  })),
  reopen: () => set((current) => persist({
    ...snapshot(current),
    status: 'active',
    collapsed: false,
  })),
  dismiss: () => set((current) => persist({
    ...snapshot(current),
    status: 'dismissed',
    collapsed: false,
  })),
  skip: () => set((current) => persist({
    ...snapshot(current), status: 'completed', currentStep: 'task', collapsed: false,
    completedSteps: [...stepOrder],
  })),
  completeStep: (step) => set((current) => {
    if (current.status !== 'active') return current
    const completedSteps = current.completedSteps.includes(step)
      ? current.completedSteps
      : [...current.completedSteps, step]
    const nextStep = stepOrder[stepOrder.indexOf(step) + 1]
    return persist({
      ...snapshot(current),
      completedSteps,
      currentStep: nextStep ?? 'task',
      status: step === 'task' ? 'completed' : 'active',
    })
  }),
  setCollapsed: (collapsed) => set((current) => persist({ ...snapshot(current), collapsed })),
  chooseSetupMode: (setupMode) => set((current) => {
    if (current.status !== 'active') return current
    return persist({
      ...snapshot(current),
      setupMode,
      providerId: setupMode === 'local' ? null : current.providerId,
      currentStep: setupMode === 'local' ? 'engine' : 'provider',
      status: 'active',
    })
  }),
  recordProvider: (providerId) => set((current) => {
    if (current.status !== 'active') return current
    return persist({
      ...snapshot(current), setupMode: 'provider', providerId, currentStep: 'engine', status: 'active',
    })
  }),
  recordEngine: (engineId) => set((current) => {
    if (current.status !== 'active') return current
    return persist({
      ...snapshot(current), engineId, currentStep: 'project', status: 'active',
    })
  }),
  recordProject: (projectId) => set((current) => {
    if (current.status !== 'active') return current
    return persist({
      ...snapshot(current), projectId, workflowId: null, taskId: null,
      currentStep: 'workflow', status: 'active',
    })
  }),
  recordWorkflow: (workflowId) => set((current) => {
    if (current.status !== 'active') return current
    return persist({
      ...snapshot(current), workflowId, taskId: null, currentStep: 'task', status: 'active',
    })
  }),
  recordTask: (taskId) => set((current) => {
    if (current.status !== 'active') return current
    return persist({
      ...snapshot(current), taskId, currentStep: 'task', status: 'completed', collapsed: false,
    })
  }),
  setCurrentStep: (currentStep) => set((current) => {
    if (current.status !== 'active') return current
    return persist({ ...snapshot(current), currentStep })
  }),
  rollback: (step) => set((current) => {
    if (current.status !== 'active') return current
    const rollbackIndex = stepOrder.indexOf(step)
    const next = {
      ...snapshot(current), status: 'active' as const, currentStep: step,
      completedSteps: current.completedSteps.filter((item) => stepOrder.indexOf(item) < rollbackIndex),
    }
    if (step === 'provider') Object.assign(next, { setupMode: null, providerId: null, engineId: null, projectId: null, workflowId: null, taskId: null })
    if (step === 'engine') Object.assign(next, { engineId: null, projectId: null, workflowId: null, taskId: null })
    if (step === 'project') Object.assign(next, { projectId: null, workflowId: null, taskId: null })
    if (step === 'workflow') Object.assign(next, { workflowId: null, taskId: null })
    if (step === 'task') Object.assign(next, { taskId: null })
    return persist(next)
  }),
  markCanvasHintSeen: () => set((current) => persist({ ...snapshot(current), canvasHintSeen: true })),
}))

export function resetOnboardingStoreForTests() {
  useOnboardingStore.setState({ ...DEFAULT_ONBOARDING_STATE })
}
