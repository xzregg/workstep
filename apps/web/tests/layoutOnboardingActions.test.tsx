import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { useLocation } from 'react-router-dom'
import { installDomEnvironment } from './helpers/domEnv'
import { engineApi, type Project } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useOnboardingStore } from '../src/stores/onboardingStore'
import { useProjectStore } from '../src/stores/projectStore'
import LayoutOnboardingActions from '../src/components/LayoutOnboardingActions'

function PathDisplay() {
  const location = useLocation()
  return <output data-path>{location.pathname}{location.search}</output>
}

test('workflow action reports missing project without calling the engine API', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const previous = useOnboardingStore.getState()
  useOnboardingStore.setState({
    status: 'active', collapsed: false, currentStep: 'workflow',
    completedSteps: ['provider', 'engine', 'project'], projectId: 'missing',
  })
  try {
    await act(async () => root.render(
      <MemoryRouter><I18nProvider><LayoutOnboardingActions
        onOpenSettings={() => undefined} onOpenProject={() => undefined}
      /></I18nProvider></MemoryRouter>,
    ))
    const workflowButton = container.querySelector<HTMLButtonElement>('.onboarding-step.is-active button')
    assert.ok(workflowButton)
    await act(async () => workflowButton.click())
    assert.ok(container.querySelector('[role="status"]')?.textContent)
  } finally {
    await act(async () => root.unmount())
    useOnboardingStore.setState(previous)
    container.remove()
    await window.happyDOM.close()
  }
})

test('workflow action creates the starter flow and opens its canvas', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const previousOnboarding = useOnboardingStore.getState()
  const previousProjects = useProjectStore.getState()
  const originalExecutionConfig = engineApi.executionConfig
  const originalModels = engineApi.models
  const project: Project = { id: 'project-one', name: '示例项目', path: '/tmp/project-one', steps: {}, workflows: [] }
  let createdSteps: unknown
  let activatedWorkflow = ''
  useOnboardingStore.setState({
    status: 'active', collapsed: false, currentStep: 'workflow',
    completedSteps: ['provider', 'engine', 'project'], projectId: project.id,
    workflowId: null, engineId: 'codex', providerId: null,
  })
  useProjectStore.setState({
    projects: [project], activeProject: project,
    setActiveProject: () => undefined,
    createWorkflow: async (_id, _name, _template, steps) => {
      createdSteps = steps
      return { id: 'workflow-one' } as Awaited<ReturnType<typeof previousProjects.createWorkflow>>
    },
    fetchProjects: async () => undefined,
    setActiveWorkflow: async (id) => { activatedWorkflow = id },
  })
  engineApi.executionConfig = async () => ({ engine: 'codex' })
  engineApi.models = async () => ({ engine_id: 'codex', models: [], default_model: 'test-model' })
  try {
    await act(async () => root.render(
      <MemoryRouter><I18nProvider><LayoutOnboardingActions
        onOpenSettings={() => undefined} onOpenProject={() => undefined}
      /><PathDisplay /></I18nProvider></MemoryRouter>,
    ))
    const workflowButton = container.querySelector<HTMLButtonElement>('.onboarding-step.is-active button')
    assert.ok(workflowButton)
    await act(async () => workflowButton.click())
    assert.ok(createdSteps)
    assert.equal(activatedWorkflow, 'workflow-one')
    assert.equal(useOnboardingStore.getState().workflowId, 'workflow-one')
    assert.match(container.querySelector('[data-path]')?.textContent || '', /\/canvas\?.*workflow=workflow-one/)
  } finally {
    engineApi.executionConfig = originalExecutionConfig
    engineApi.models = originalModels
    await act(async () => root.unmount())
    useProjectStore.setState(previousProjects)
    useOnboardingStore.setState(previousOnboarding)
    container.remove()
    await window.happyDOM.close()
  }
})
