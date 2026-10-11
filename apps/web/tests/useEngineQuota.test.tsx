import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi } from '../src/api/client'
import { useEngineQuota } from '../src/hooks/useEngineQuota'
import ChatInputUsage from '../src/components/ChatInputUsage'
import { I18nProvider } from '../src/i18n'

function QuotaHarness({ engine, running, projectId = 'project-1' }: {
  engine: string
  running: boolean
  projectId?: string
}) {
  const { quota, refreshing, refresh } = useEngineQuota(projectId, engine, running)
  return <div>
    <span data-quota>{quota?.engine_id ?? ''}</span>
    <span data-refreshing>{String(refreshing)}</span>
    <I18nProvider><ChatInputUsage quota={quota} compact onRefreshQuota={() => { void refresh() }} quotaRefreshing={refreshing} /></I18nProvider>
    <button type="button" onClick={() => { void refresh() }}>刷新</button>
  </div>
}

test('quota ignores stale engine results and refreshes after a run', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  const originalQuota = engineApi.quota
  const requests: Array<{ engine: string; projectId: string; resolve: (value: never) => void }> = []
  engineApi.quota = (engine, projectId) => new Promise((resolve) => {
    requests.push({ engine, projectId, resolve })
  })
  try {
    await act(async () => root.render(<QuotaHarness engine="engine-a" running={false} />))
    assert.deepEqual(requests.map((request) => request.engine), ['engine-a'])
    assert.equal(container.querySelector('[data-refreshing]')?.textContent, 'true')

    await act(async () => root.render(<QuotaHarness engine="engine-b" running={false} />))
    assert.deepEqual(requests.map((request) => request.engine), ['engine-a', 'engine-b'])
    await act(async () => requests[0].resolve({ quota: { engine_id: 'engine-a' } } as never))
    assert.equal(container.querySelector('[data-quota]')?.textContent, '')
    await act(async () => requests[1].resolve({ quota: { engine_id: 'engine-b' } } as never))
    assert.equal(container.querySelector('[data-quota]')?.textContent, 'engine-b')

    await act(async () => root.render(<QuotaHarness engine="engine-b" projectId="project-2" running={false} />))
    assert.equal(container.querySelector('[data-quota]')?.textContent, '')
    assert.equal(requests[2].projectId, 'project-2')
    await act(async () => requests[2].resolve({ quota: { engine_id: 'engine-b' } } as never))

    await act(async () => root.render(<QuotaHarness engine="engine-b" projectId="project-2" running />))
    assert.equal(container.querySelector('[data-refreshing]')?.textContent, 'true')
    await act(async () => root.render(<QuotaHarness engine="engine-b" projectId="project-2" running={false} />))
    assert.equal(requests.length, 5)
    await act(async () => requests[3].resolve({ quota: { engine_id: 'engine-b' } } as never))
    assert.equal(container.querySelector('[data-refreshing]')?.textContent, 'true')
    await act(async () => requests[4].resolve({ quota: { engine_id: 'engine-b' } } as never))
  } finally {
    engineApi.quota = originalQuota
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('quota loads when entering a running conversation and switching its engine', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  const originalQuota = engineApi.quota
  const requests: string[] = []
  engineApi.quota = async (engine) => {
    requests.push(engine)
    return { quota: { engine_id: engine } } as never
  }
  try {
    await act(async () => root.render(<QuotaHarness engine="engine-a" running />))
    assert.deepEqual(requests, ['engine-a'])
    assert.equal(container.querySelector('[data-quota]')?.textContent, 'engine-a')

    await act(async () => root.render(<QuotaHarness engine="engine-b" running />))
    assert.deepEqual(requests, ['engine-a', 'engine-b'])
    assert.equal(container.querySelector('[data-quota]')?.textContent, 'engine-b')
  } finally {
    engineApi.quota = originalQuota
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const url of ['http://localhost/workspace/device-1/chat', 'https://d-device-1.gateway.test/chat']) {
  test(`mobile gateway quota loads and refreshes in ${url}`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL(url)
    window.innerWidth = 390
    const originalQuota = engineApi.quota
    const requests: Array<[string, string]> = []
    engineApi.quota = async (engine, projectId) => {
      requests.push([engine, projectId])
      return {
        engine_id: engine, supported: true,
        quota: { engine_id: engine, primary: { remaining_percent: requests.length === 1 ? 81 : 75 } },
      } as never
    }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<QuotaHarness engine="codex_sdk" running={false} />))
      assert.deepEqual(requests, [['codex_sdk', 'project-1']])
      const quota = container.querySelector<HTMLElement>('.chat-input-quota')!
      assert.ok(quota)
      assert.match(quota.textContent || '', /81%/)
      await act(async () => quota.click())
      assert.ok(quota.classList.contains('is-tip-open'))
      await act(async () => container.querySelector<HTMLButtonElement>('[data-quota-refresh]')!.click())
      assert.deepEqual(requests, [['codex_sdk', 'project-1'], ['codex_sdk', 'project-1']])
      assert.match(quota.textContent || '', /75%/)
    } finally {
      await act(async () => root.unmount())
      engineApi.quota = originalQuota
      await window.happyDOM.close()
    }
  })
}
