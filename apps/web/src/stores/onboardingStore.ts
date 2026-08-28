import { create } from 'zustand'
import {
  DEFAULT_ONBOARDING_STATE,
  loadOnboardingState,
  saveOnboardingState,
  type OnboardingState,
  type OnboardingStep,
} from '../utils/onboarding'

interface OnboardingStore extends OnboardingState {
  start: () => void
  reopen: () => void
  dismiss: () => void
  setCollapsed: (collapsed: boolean) => void
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

const snapshot = (state: OnboardingStore): OnboardingState => ({
  status: state.status,
  currentStep: state.currentStep,
  collapsed: state.collapsed,
  providerId: state.providerId,
  engineId: state.engineId,
  projectId: state.projectId,
  workflowId: state.workflowId,
  taskId: state.taskId,
  canvasHintSeen: state.canvasHintSeen,
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
  setCollapsed: (collapsed) => set((current) => persist({ ...snapshot(current), collapsed })),
  recordProvider: (providerId) => set((current) => persist({
    ...snapshot(current), providerId, currentStep: 'engine', status: 'active',
  })),
  recordEngine: (engineId) => set((current) => persist({
    ...snapshot(current), engineId, currentStep: 'project', status: 'active',
  })),
  recordProject: (projectId) => set((current) => persist({
    ...snapshot(current), projectId, workflowId: null, taskId: null,
    currentStep: 'workflow', status: 'active',
  })),
  recordWorkflow: (workflowId) => set((current) => persist({
    ...snapshot(current), workflowId, taskId: null, currentStep: 'task', status: 'active',
  })),
  recordTask: (taskId) => set((current) => persist({
    ...snapshot(current), taskId, currentStep: 'task', status: 'completed', collapsed: false,
  })),
  setCurrentStep: (currentStep) => set((current) => persist({
    ...snapshot(current), currentStep,
    status: current.status === 'completed' ? 'active' : current.status,
  })),
  rollback: (step) => set((current) => {
    const next = { ...snapshot(current), status: 'active' as const, currentStep: step }
    if (step === 'provider') Object.assign(next, { providerId: null, engineId: null, projectId: null, workflowId: null, taskId: null })
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
