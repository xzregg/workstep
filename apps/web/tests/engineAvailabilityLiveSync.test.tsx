import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import EngineSelect from '../src/components/EngineSelect'
import { I18nProvider } from '../src/i18n'
import type { EngineInfo } from '../api/client'
import {
  publishEngineCatalog,
  resetEngineAvailabilityStoreForTests,
  toCoordinatorEngines,
  useCoordinatorEngines,
  useEngineAvailabilityStore,
  useEngineRevision,
} from '../src/stores/engineAvailabilityStore'
import { installDomEnvironment } from './helpers/domEnv'

function engine(id: string, overrides: Partial<EngineInfo> = {}): EngineInfo {
  return {
    id,
    installed: true,
    configured: true,
    verified: true,
    built_in: false,
    version: '1.0.0',
    mode: 'cli',
    config: null,
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
    supports_live_step_message: false,
    supports_provider: false,
    provider_protocols: [],
    binary_path: id,
    configured_path: null,
    ...overrides,
  } as EngineInfo
}

/** 模拟聊天框：引擎可用性只订阅共享状态，不持有自己的快照。 */
function ComposerHost() {
  const engines = useCoordinatorEngines()
  const revision = useEngineRevision()
  return (
    <div data-revision={revision}>
      <EngineSelect engines={engines} value="claude" onChange={() => {}} requireCoordinator />
    </div>
  )
}

function optionState(document: Document, id: string) {
  const option = document.querySelector(`option[value="${id}"]`)
  return { exists: option != null, disabled: option ? option.hasAttribute('disabled') : null }
}

test('availability list follows the backend coordinator filter', () => {
  resetEngineAvailabilityStoreForTests()
  const summaries = toCoordinatorEngines([
    engine('claude'),
    engine('openclaw', { supports_coordinator: false }),
    engine('codex', { installed: false }),
    engine('pydantic_ai', { built_in: true, supports_coordinator: false }),
  ])
  assert.deepEqual(
    summaries.map((item) => item.id),
    ['claude', 'pydantic_ai'],
  )
})

test('publishing only bumps the revision when availability actually changes', () => {
  resetEngineAvailabilityStoreForTests()
  publishEngineCatalog([engine('claude'), engine('codex')])
  const first = useEngineAvailabilityStore.getState().revision
  assert.ok(first > 0, '首次发布应 bump revision')

  publishEngineCatalog([engine('claude'), engine('codex')])
  assert.equal(useEngineAvailabilityStore.getState().revision, first,
    '重复发布同样的可用性不该 bump（避免下游无谓重拉）')

  publishEngineCatalog([engine('claude', { verified: false }), engine('codex')])
  assert.equal(useEngineAvailabilityStore.getState().revision, first + 1,
    'verified 变化必须 bump，聊天框才能即时禁用')
})

test('engine option enables live after the settings page publishes a state change', async () => {
  const { window, document } = installDomEnvironment()
  resetEngineAvailabilityStoreForTests()
  // 初始：claude 未测试通过 → 禁用；codex 可用。
  publishEngineCatalog([engine('claude', { verified: false }), engine('codex')])
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(<I18nProvider><ComposerHost /></I18nProvider>)
    })
    assert.deepEqual(optionState(document, 'claude'), { exists: true, disabled: true })
    assert.deepEqual(optionState(document, 'codex'), { exists: true, disabled: false })

    // 模拟用户在设置页测试通过 claude：设置页发布新目录，聊天框不重新挂载也必须跟随。
    await act(async () => {
      publishEngineCatalog([engine('claude', { verified: true }), engine('codex')])
    })
    assert.equal(optionState(document, 'claude').disabled, false,
      'claude 应在设置页改完后立即可选，无需刷新页面')

    // 反向：配置被清空导致不可用时，也要立即禁用。
    await act(async () => {
      publishEngineCatalog([engine('claude', { configured: false }), engine('codex')])
    })
    assert.equal(optionState(document, 'claude').disabled, true,
      '失去配置的引擎应立即禁用')
  } finally {
    await act(async () => { root.unmount() })
    await window.happyDOM.close()
  }
})

test('an uninstalled engine drops out of the picker list', async () => {
  const { window, document } = installDomEnvironment()
  resetEngineAvailabilityStoreForTests()
  publishEngineCatalog([engine('claude'), engine('hermes')])
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(<I18nProvider><ComposerHost /></I18nProvider>)
    })
    assert.equal(optionState(document, 'hermes').exists, true)
    await act(async () => {
      publishEngineCatalog([engine('claude'), engine('hermes', { installed: false })])
    })
    assert.equal(optionState(document, 'hermes').exists, false,
      '卸载后的引擎不该继续出现在下拉里')
  } finally {
    await act(async () => { root.unmount() })
    await window.happyDOM.close()
  }
})


test('visibility changes publish immediately without removing engine metadata', () => {
  resetEngineAvailabilityStoreForTests()
  publishEngineCatalog([engine('claude', { enabled: true })])
  const revision = useEngineAvailabilityStore.getState().revision
  publishEngineCatalog([engine('claude', { enabled: false })])
  assert.equal(useEngineAvailabilityStore.getState().revision, revision + 1)
  assert.equal(useEngineAvailabilityStore.getState().engines[0].enabled, false)
})


test('hidden engines disappear live and a saved selection stays unchanged', async () => {
  const { window, document } = installDomEnvironment()
  resetEngineAvailabilityStoreForTests()
  publishEngineCatalog([engine('claude'), engine('codex')])
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => { root.render(<I18nProvider><ComposerHost /></I18nProvider>) })
    await act(async () => { publishEngineCatalog([engine('claude', { enabled: false }), engine('codex', { enabled: false })]) })
    assert.equal(document.querySelector('option[value="codex"]'), null)
    assert.equal(document.querySelector('option[value="claude"]')?.hasAttribute('hidden'), true)
    assert.equal(document.querySelector('select')?.value, 'claude')
    await act(async () => { publishEngineCatalog([engine('claude', { enabled: true }), engine('codex', { enabled: true })]) })
    assert.equal(document.querySelector('option[value="claude"]')?.hasAttribute('hidden'), false)
    assert.equal(optionState(document, 'codex').disabled, false)
  } finally {
    await act(async () => { root.unmount() })
    await window.happyDOM.close()
  }
})
