import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskStepConfigController from '../src/components/TaskStepConfigController'
import { I18nProvider } from '../src/i18n'
import { taskApi, type StepExecutionConfig } from '../src/api/client'

const engine = (id: string) => ({
  id,
  default_model: `${id}-default`,
  installed: true,
  configured: true,
  verified: true,
  built_in: false,
  version: '1',
  mode: 'cli',
  config: { fields: [], step_fields: [], values: {}, secrets: {} },
  installable: false,
  install_command: null,
  updatable: false,
  update_command: null,
  requires_third_party_terms_acceptance: false,
  third_party_terms_url: null,
  supports_resume: true,
  supports_session_fork: false,
  supports_coordinator: true,
  supports_tool_disable: false,
  supports_native_schema: false,
  supports_live_step_message: true,
  supports_provider: false,
  provider_protocols: [],
  binary_path: id,
  configured_path: null,
}) as never

const detail: StepExecutionConfig = {
  configured: null,
  resolved: { engine: 'engine-a', model: 'flow-model', config: {} },
  source: 'workflow',
  editable: true,
  status: 'passed',
  has_history: true,
  message_count: 2,
  session_engine: 'engine-a',
  session_provider: null,
  available_engines: [engine('engine-a'), engine('engine-b')],
}

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

test('step config loads the workflow selection and is read-only while running', async () => {
  const window = installDom()
  const original = taskApi.stepExecutionConfig
  taskApi.stepExecutionConfig = async () => ({ ...detail, editable: false, status: 'running' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepConfigController projectId="p" taskId="t" stepKey="do" running>
            {({ inputConfig }) => <span data-engine={inputConfig?.engine} data-disabled={String(inputConfig?.disabled)} />}
          </TaskStepConfigController>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const state = container.querySelector('span')
    assert.equal(state?.getAttribute('data-engine'), 'engine-a')
    assert.equal(state?.getAttribute('data-disabled'), 'true')
  } finally {
    taskApi.stepExecutionConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('step config exposes its resolved thinking effort as the inheritance default', async () => {
  const window = installDom()
  const original = taskApi.stepExecutionConfig
  const thinkingDetail: StepExecutionConfig = {
    ...detail,
    resolved: {
      engine: 'engine-a',
      model: 'flow-model',
      config: { model_reasoning_effort: 'minimal' },
    },
    available_engines: [{
      ...engine('engine-a'),
      config: {
        fields: [],
        step_fields: [{
          key: 'model_reasoning_effort',
          label: '思考强度',
          type: 'select',
          options: [{ value: 'minimal', label: '极简' }],
          required: false,
          sensitive: false,
        }],
        values: {},
        secrets: {},
      },
    }],
  }
  taskApi.stepExecutionConfig = async () => thinkingDetail
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ inputConfig }) => (
              <span
                data-effort={inputConfig?.stepValues?.model_reasoning_effort}
                data-thinking={inputConfig?.thinkingEffort}
                data-field={String(inputConfig?.stepFields?.some(
                  (field) => field.key === 'model_reasoning_effort',
                ))}
              />
            )}
          </TaskStepConfigController>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const state = container.querySelector('span')
    assert.equal(state?.getAttribute('data-effort'), 'minimal')
    assert.equal(state?.getAttribute('data-thinking'), 'minimal')
    assert.equal(state?.getAttribute('data-field'), 'true')
  } finally {
    taskApi.stepExecutionConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('step config exposes loading state until the selected step configuration resolves', async () => {
  const window = installDom()
  const original = taskApi.stepExecutionConfig
  let resolveConfig: ((value: StepExecutionConfig) => void) | undefined
  taskApi.stepExecutionConfig = () => new Promise((resolve) => { resolveConfig = resolve })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ loading, inputConfig }) => (
              <span data-loading={String(loading)} data-ready={String(Boolean(inputConfig))} />
            )}
          </TaskStepConfigController>
        </I18nProvider>,
      )
    })
    assert.equal(container.querySelector('span')?.getAttribute('data-loading'), 'true')
    assert.equal(container.querySelector('span')?.getAttribute('data-ready'), 'false')

    await act(async () => { resolveConfig?.(detail); await Promise.resolve() })
    assert.equal(container.querySelector('span')?.getAttribute('data-loading'), 'false')
    assert.equal(container.querySelector('span')?.getAttribute('data-ready'), 'true')
  } finally {
    taskApi.stepExecutionConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('switching a step with history confirms smart handoff before saving', async () => {
  const window = installDom()
  const originals = {
    get: taskApi.stepExecutionConfig,
    update: taskApi.updateStepExecutionConfig,
  }
  taskApi.stepExecutionConfig = async () => detail
  let savedMode = ''
  let savedEngine = ''
  taskApi.updateStepExecutionConfig = async (_task, _step, _project, selection, mode) => {
    savedEngine = selection.engine
    savedMode = mode || ''
    return { ...detail, configured: selection, resolved: selection, source: 'task_override' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ inputConfig }) => (
              <button onClick={() => inputConfig?.onEngineChange('engine-b')}>switch</button>
            )}
          </TaskStepConfigController>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    assert.match(document.body.textContent || '', /确认交接/)
    const confirm = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('确认交接'))
    assert.ok(confirm)
    await act(async () => confirm.click())
    assert.equal(savedEngine, 'engine-b')
    assert.equal(savedMode, 'smart')
  } finally {
    taskApi.stepExecutionConfig = originals.get
    taskApi.updateStepExecutionConfig = originals.update
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('switching a step provider with history confirms handoff even without a reusable session', async () => {
  const window = installDom()
  const originals = {
    get: taskApi.stepExecutionConfig,
    update: taskApi.updateStepExecutionConfig,
  }
  const providerDetail: StepExecutionConfig = {
    ...detail,
    resolved: {
      engine: 'engine-a',
      model: 'flow-model',
      config: { provider_id: 'provider-a' },
    },
    session_provider: null,
    available_engines: [{
      ...engine('engine-a'),
      supports_provider: true,
      provider_protocols: ['anthropic_messages'],
      config: {
        fields: [],
        step_fields: [{
          key: 'provider_id',
          label: '供应商',
          type: 'select',
          options: [
            { value: 'provider-a', label: 'Provider A' },
            { value: 'provider-b', label: 'Provider B' },
          ],
          required: false,
          sensitive: false,
        }],
        values: {},
        secrets: {},
      },
    }],
  }
  taskApi.stepExecutionConfig = async () => providerDetail
  let savedMode = ''
  let savedProvider = ''
  taskApi.updateStepExecutionConfig = async (_task, _step, _project, selection, mode) => {
    savedProvider = selection.config.provider_id || ''
    savedMode = mode || ''
    return { ...providerDetail, configured: selection, resolved: selection, source: 'task_override' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStepConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ inputConfig }) => (
              <button onClick={() => inputConfig?.onStepFieldChange?.('provider_id', 'provider-b')}>
                switch provider
              </button>
            )}
          </TaskStepConfigController>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    assert.match(document.body.textContent || '', /确认交接/)
    assert.equal(savedProvider, '')
    const confirm = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('确认交接'))
    assert.ok(confirm)
    await act(async () => confirm.click())
    assert.equal(savedProvider, 'provider-b')
    assert.equal(savedMode, 'smart')
  } finally {
    taskApi.stepExecutionConfig = originals.get
    taskApi.updateStepExecutionConfig = originals.update
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('step provider returns to its original selection without another handoff before execution', async () => {
  const window = installDom()
  const originals = { get: taskApi.stepExecutionConfig, update: taskApi.updateStepExecutionConfig }
  const initial = { ...detail, resolved: { ...detail.resolved, config: { provider_id: 'provider-a' } } }
  taskApi.stepExecutionConfig = async () => initial
  const saved: Array<{ provider: string; mode: string | undefined }> = []
  taskApi.updateStepExecutionConfig = async (_task, _step, _project, selection, mode) => {
    saved.push({ provider: selection.config.provider_id || '', mode })
    return { ...initial, configured: selection, resolved: selection, source: 'task_override' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<I18nProvider>
        <TaskStepConfigController projectId="p" taskId="t" stepKey="do" running={false}>
          {({ inputConfig }) => <>{['provider-b', 'provider-c', 'provider-a'].map((provider) => (
            <button key={provider} data-provider={provider} onClick={() => inputConfig?.onStepFieldChange?.('provider_id', provider)}>{provider}</button>
          ))}</>}
        </TaskStepConfigController>
      </I18nProvider>)
    })
    for (const provider of ['provider-b', 'provider-c']) {
      await act(async () => { (container.querySelector(`[data-provider="${provider}"]`) as HTMLButtonElement).click() })
      assert.ok(container.querySelector('[role="dialog"]'))
      await act(async () => { (container.querySelector('.btn-primary') as HTMLButtonElement).click() })
    }
    await act(async () => { (container.querySelector('[data-provider="provider-a"]') as HTMLButtonElement).click() })
    assert.equal(container.querySelector('[role="dialog"]'), null)
    assert.deepEqual(saved, [
      { provider: 'provider-b', mode: 'smart' },
      { provider: 'provider-c', mode: 'smart' },
      { provider: 'provider-a', mode: undefined },
    ])
  } finally {
    taskApi.stepExecutionConfig = originals.get
    taskApi.updateStepExecutionConfig = originals.update
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
