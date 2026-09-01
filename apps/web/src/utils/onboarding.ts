export const ONBOARDING_STORAGE_KEY = 'workstep:onboarding:v1'

export type OnboardingStep = 'provider' | 'engine' | 'project' | 'workflow' | 'task'
export type OnboardingStatus = 'active' | 'dismissed' | 'completed'
export type OnboardingSetupMode = 'provider' | 'local'

export interface OnboardingState {
  status: OnboardingStatus
  currentStep: OnboardingStep
  collapsed: boolean
  setupMode: OnboardingSetupMode | null
  providerId: string | null
  engineId: string | null
  projectId: string | null
  workflowId: string | null
  taskId: string | null
  canvasHintSeen: boolean
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  status: 'dismissed',
  currentStep: 'provider',
  collapsed: false,
  setupMode: null,
  providerId: null,
  engineId: null,
  projectId: null,
  workflowId: null,
  taskId: null,
  canvasHintSeen: false,
}

const statuses = new Set<OnboardingStatus>(['active', 'dismissed', 'completed'])
const steps = new Set<OnboardingStep>(['provider', 'engine', 'project', 'workflow', 'task'])
const setupModes = new Set<OnboardingSetupMode>(['provider', 'local'])
const nullableString = (value: unknown): string | null => typeof value === 'string' && value ? value : null

export function loadOnboardingState(storage: StorageLike | null = typeof window === 'undefined' ? null : window.localStorage): OnboardingState {
  if (!storage) return { ...DEFAULT_ONBOARDING_STATE }
  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_ONBOARDING_STATE }
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!statuses.has(value.status as OnboardingStatus) || !steps.has(value.currentStep as OnboardingStep)) {
      return { ...DEFAULT_ONBOARDING_STATE }
    }
    return {
      status: value.status as OnboardingStatus,
      currentStep: value.currentStep as OnboardingStep,
      collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : false,
      setupMode: setupModes.has(value.setupMode as OnboardingSetupMode)
        ? value.setupMode as OnboardingSetupMode
        : null,
      providerId: nullableString(value.providerId),
      engineId: nullableString(value.engineId),
      projectId: nullableString(value.projectId),
      workflowId: nullableString(value.workflowId),
      taskId: nullableString(value.taskId),
      canvasHintSeen: typeof value.canvasHintSeen === 'boolean' ? value.canvasHintSeen : false,
    }
  } catch {
    return { ...DEFAULT_ONBOARDING_STATE }
  }
}

export function saveOnboardingState(state: OnboardingState, storage: StorageLike | null = typeof window === 'undefined' ? null : window.localStorage) {
  storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state))
}

export function shouldOfferOnboarding(
  loaded: boolean,
  userName: string,
  stored: Pick<OnboardingState, 'status'> | null,
) {
  return loaded && !userName.trim() && stored === null
}

export interface OnboardingProvider {
  id: string
  enabled: boolean
  has_key: boolean
  base_url: string
  protocol: string
  type: string
}

export interface OnboardingProviderType {
  id: string
  auth: string
}

export function isProviderReady(provider: OnboardingProvider, type?: OnboardingProviderType) {
  return Boolean(
    provider.enabled
    && provider.base_url.trim()
    && (type?.auth === 'none' || provider.has_key),
  )
}

export interface OnboardingEngine {
  id: string
  installed: boolean
  configured: boolean
  verified: boolean
  supports_provider: boolean
  provider_protocols: string[]
}

export function isEngineReady(
  engine: OnboardingEngine,
  execution: { engine: string },
) {
  return Boolean(
    execution.engine === engine.id
    && engine.installed
    && engine.configured
    && engine.verified
  )
}

export function buildStarterWorkflow(engine: string, model = '') {
  return {
    nodes: [
      {
        id: 1,
        type: 'onboarding_analysis',
        title: '需求分析',
        position: { x: 160, y: 220 },
        color: '#0071e3',
        autoStart: false,
        engine,
        model,
        prompt: '分析任务目标、约束和现有信息，拆解为清晰可执行的步骤，并输出 Markdown 格式的执行计划。',
        review: { mode: 'skip', auto: false, maxRetries: 1, engine: '', model: '', prompt: '' },
        inputs: [{
          name: '任务需求',
          type: 'Markdown',
          outputs: [{ name: '执行计划', type: 'Markdown' }],
        }],
        outputs: [{ name: '执行计划', type: 'Markdown' }],
      },
      {
        id: 2,
        type: 'onboarding_execute',
        title: '执行任务',
        position: { x: 520, y: 220 },
        color: '#7c3aed',
        autoStart: false,
        engine,
        model,
        prompt: '按照执行计划完成任务，核对需求和约束，并输出 Markdown 格式的最终结果。',
        review: { mode: 'skip', auto: false, maxRetries: 1, engine: '', model: '', prompt: '' },
        inputs: [{
          name: '执行计划',
          type: 'Markdown',
          outputs: [{ name: '执行结果', type: 'Markdown' }],
        }],
        outputs: [{ name: '执行结果', type: 'Markdown' }],
      },
    ],
    connections: [{ from: 1, fromPort: 0, to: 2, toPort: 0 }],
  }
}
