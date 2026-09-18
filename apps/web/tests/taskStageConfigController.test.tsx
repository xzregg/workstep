import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskStageConfigController from '../src/components/TaskStageConfigController'
import { I18nProvider } from '../src/i18n'
import { taskApi, type StageExecutionConfig } from '../src/api/client'

const engine = (id: string) => ({
  id,
  default_model: `${id}-default`,
  installed: true,
  configured: true,
  verified: true,
  built_in: false,
  version: '1',
  mode: 'cli',
  config: { fields: [], stage_fields: [], values: {}, secrets: {} },
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
  supports_live_stage_message: true,
  supports_provider: false,
  provider_protocols: [],
  binary_path: id,
  configured_path: null,
}) as never

const detail: StageExecutionConfig = {
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

test('stage config loads the workflow selection and is read-only while running', async () => {
  const window = installDom()
  const original = taskApi.stageExecutionConfig
  taskApi.stageExecutionConfig = async () => ({ ...detail, editable: false, status: 'running' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStageConfigController projectId="p" taskId="t" stepKey="do" running>
            {({ inputConfig }) => <span data-engine={inputConfig?.engine} data-disabled={String(inputConfig?.disabled)} />}
          </TaskStageConfigController>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const state = container.querySelector('span')
    assert.equal(state?.getAttribute('data-engine'), 'engine-a')
    assert.equal(state?.getAttribute('data-disabled'), 'true')
  } finally {
    taskApi.stageExecutionConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('stage config exposes its resolved thinking effort as the inheritance default', async () => {
  const window = installDom()
  const original = taskApi.stageExecutionConfig
  const thinkingDetail: StageExecutionConfig = {
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
        stage_fields: [{
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
  taskApi.stageExecutionConfig = async () => thinkingDetail
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStageConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ inputConfig }) => (
              <span
                data-effort={inputConfig?.stageValues?.model_reasoning_effort}
                data-thinking={inputConfig?.thinkingEffort}
                data-field={String(inputConfig?.stageFields?.some(
                  (field) => field.key === 'model_reasoning_effort',
                ))}
              />
            )}
          </TaskStageConfigController>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const state = container.querySelector('span')
    assert.equal(state?.getAttribute('data-effort'), 'minimal')
    assert.equal(state?.getAttribute('data-thinking'), 'minimal')
    assert.equal(state?.getAttribute('data-field'), 'true')
  } finally {
    taskApi.stageExecutionConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('stage config exposes loading state until the selected stage configuration resolves', async () => {
  const window = installDom()
  const original = taskApi.stageExecutionConfig
  let resolveConfig: ((value: StageExecutionConfig) => void) | undefined
  taskApi.stageExecutionConfig = () => new Promise((resolve) => { resolveConfig = resolve })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskStageConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ loading, inputConfig }) => (
              <span data-loading={String(loading)} data-ready={String(Boolean(inputConfig))} />
            )}
          </TaskStageConfigController>
        </I18nProvider>,
      )
    })
    assert.equal(container.querySelector('span')?.getAttribute('data-loading'), 'true')
    assert.equal(container.querySelector('span')?.getAttribute('data-ready'), 'false')

    await act(async () => { resolveConfig?.(detail); await Promise.resolve() })
    assert.equal(container.querySelector('span')?.getAttribute('data-loading'), 'false')
    assert.equal(container.querySelector('span')?.getAttribute('data-ready'), 'true')
  } finally {
    taskApi.stageExecutionConfig = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('switching a stage with history confirms smart handoff before saving', async () => {
  const window = installDom()
  const originals = {
    get: taskApi.stageExecutionConfig,
    update: taskApi.updateStageExecutionConfig,
  }
  taskApi.stageExecutionConfig = async () => detail
  let savedMode = ''
  let savedEngine = ''
  taskApi.updateStageExecutionConfig = async (_task, _step, _project, selection, mode) => {
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
          <TaskStageConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ inputConfig }) => (
              <button onClick={() => inputConfig?.onEngineChange('engine-b')}>switch</button>
            )}
          </TaskStageConfigController>
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
    taskApi.stageExecutionConfig = originals.get
    taskApi.updateStageExecutionConfig = originals.update
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('switching a stage provider with history confirms handoff even without a reusable session', async () => {
  const window = installDom()
  const originals = {
    get: taskApi.stageExecutionConfig,
    update: taskApi.updateStageExecutionConfig,
  }
  const providerDetail: StageExecutionConfig = {
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
        stage_fields: [{
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
  taskApi.stageExecutionConfig = async () => providerDetail
  let savedMode = ''
  let savedProvider = ''
  taskApi.updateStageExecutionConfig = async (_task, _step, _project, selection, mode) => {
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
          <TaskStageConfigController projectId="p" taskId="t" stepKey="do" running={false}>
            {({ inputConfig }) => (
              <button onClick={() => inputConfig?.onStageFieldChange?.('provider_id', 'provider-b')}>
                switch provider
              </button>
            )}
          </TaskStageConfigController>
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
    taskApi.stageExecutionConfig = originals.get
    taskApi.updateStageExecutionConfig = originals.update
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
