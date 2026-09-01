import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStarterWorkflow,
  isEngineReady,
  isProviderReady,
  loadOnboardingState,
  saveOnboardingState,
  shouldOfferOnboarding,
  type OnboardingState,
} from '../src/utils/onboarding'
import { resetOnboardingStoreForTests, useOnboardingStore } from '../src/stores/onboardingStore'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

test('onboarding state round-trips and rejects malformed persisted values', () => {
  const storage = new MemoryStorage()
  const state: OnboardingState = {
    status: 'active',
    currentStep: 'workflow',
    collapsed: true,
    setupMode: 'provider',
    providerId: 'provider-1',
    engineId: 'pydantic_ai',
    projectId: 'project-1',
    workflowId: 'workflow-1',
    taskId: null,
    canvasHintSeen: false,
  }

  saveOnboardingState(state, storage)
  assert.deepEqual(loadOnboardingState(storage), state)

  storage.setItem('workstep:onboarding:v1', JSON.stringify({ status: 'unknown', currentStep: 42 }))
  assert.deepEqual(loadOnboardingState(storage), {
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
  })
})

test('only a new installation is offered onboarding automatically', () => {
  assert.equal(shouldOfferOnboarding(true, '', null), true)
  assert.equal(shouldOfferOnboarding(true, '已有用户', null), false)
  assert.equal(shouldOfferOnboarding(false, '', null), false)
  assert.equal(shouldOfferOnboarding(true, '', { status: 'dismissed' }), false)
})

test('provider readiness requires a usable configuration', () => {
  const provider = {
    id: 'provider-1', enabled: true, has_key: true,
    base_url: 'https://api.example.com', protocol: 'openai_responses', type: 'openai',
  }
  assert.equal(isProviderReady(provider, { id: 'openai', auth: 'api_key' }), true)
  assert.equal(isProviderReady({ ...provider, has_key: false }, { id: 'openai', auth: 'api_key' }), false)
  assert.equal(isProviderReady({ ...provider, has_key: false }, { id: 'openai', auth: 'none' }), true)

})

test('engine readiness requires an explicitly saved and tested default engine', () => {
  const engine = {
    id: 'pydantic_ai', installed: true, configured: true, verified: true,
    supports_provider: true, provider_protocols: ['openai_responses'],
  }
  assert.equal(isEngineReady(engine, { engine: 'pydantic_ai' }), true)
  assert.equal(isEngineReady({ ...engine, configured: false }, { engine: 'pydantic_ai' }), false)
  assert.equal(isEngineReady({ ...engine, verified: false }, { engine: 'pydantic_ai' }), false)
  assert.equal(isEngineReady(engine, { engine: 'codex_sdk' }), false)
})

test('onboarding can choose either a provider or a local Agent setup path', () => {
  resetOnboardingStoreForTests()
  useOnboardingStore.getState().chooseSetupMode('local')
  assert.equal(useOnboardingStore.getState().setupMode, 'local')
  assert.equal(useOnboardingStore.getState().providerId, null)
  assert.equal(useOnboardingStore.getState().currentStep, 'engine')

  useOnboardingStore.getState().chooseSetupMode('provider')
  assert.equal(useOnboardingStore.getState().setupMode, 'provider')
  assert.equal(useOnboardingStore.getState().currentStep, 'provider')
})

test('starter workflow connects analysis output to execution input with one engine', () => {
  const steps = buildStarterWorkflow('pydantic_ai', 'gpt-5.5')

  assert.equal(steps.nodes.length, 2)
  assert.deepEqual(steps.nodes.map((node) => node.title), ['需求分析', '执行任务'])
  assert.deepEqual(steps.nodes.map((node) => [node.engine, node.model]), [
    ['pydantic_ai', 'gpt-5.5'],
    ['pydantic_ai', 'gpt-5.5'],
  ])
  assert.deepEqual(steps.nodes[0].outputs, [{ name: '执行计划', type: 'Markdown' }])
  assert.deepEqual(steps.nodes[1].inputs, [{
    name: '执行计划',
    type: 'Markdown',
    outputs: [{ name: '执行结果', type: 'Markdown' }],
  }])
  assert.deepEqual(steps.connections, [{ from: 1, fromPort: 0, to: 2, toPort: 0 }])
  assert.equal(steps.nodes.some((node) => node.autoStart), false)
})

test('resource deletion rolls the persisted checklist back to the affected step', () => {
  resetOnboardingStoreForTests()
  const onboarding = useOnboardingStore.getState()
  onboarding.start()
  onboarding.recordProvider('provider-1')
  onboarding.recordEngine('pydantic_ai')
  onboarding.recordProject('project-1')
  onboarding.recordWorkflow('workflow-1')
  onboarding.recordTask('task-1')

  useOnboardingStore.getState().rollback('workflow')
  const state = useOnboardingStore.getState()
  assert.equal(state.status, 'active')
  assert.equal(state.currentStep, 'workflow')
  assert.equal(state.projectId, 'project-1')
  assert.equal(state.workflowId, null)
  assert.equal(state.taskId, null)
})
