import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi } from '../src/api/client'
import { useEngineQuota } from '../src/hooks/useEngineQuota'

function QuotaHarness({ engine, running, projectId = 'project-1' }: {
  engine: string
  running: boolean
  projectId?: string
}) {
  const { quota, refreshing, refresh } = useEngineQuota(projectId, engine, running)
  return <div>
    <span data-quota>{quota?.engine_id ?? ''}</span>
    <span data-refreshing>{String(refreshing)}</span>
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
    assert.equal(container.querySelector('[data-refreshing]')?.textContent, 'false')
    await act(async () => root.render(<QuotaHarness engine="engine-b" projectId="project-2" running={false} />))
    assert.equal(requests.length, 4)
    await act(async () => requests[3].resolve({ quota: { engine_id: 'engine-b' } } as never))
  } finally {
    engineApi.quota = originalQuota
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
