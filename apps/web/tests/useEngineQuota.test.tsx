import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi } from '../src/api/client'
import { useEngineQuota } from '../src/hooks/useEngineQuota'

 test('unified quota follows conversation scope, selects locally and only manual refresh bypasses cache', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = engineApi.quotas
  const calls: Array<[string, boolean]> = []
  engineApi.quotas = async (project = '', force = false) => {
    calls.push([project, force])
    return { engines: ['a', 'b'].map(engine_id => ({ engine_id, supported: true, status: 'ok' as const,
      quota: {engine_id, primary: {remaining_percent: 80, used_percent: 20}} })), cached: false, collected_at: 1, expires_at: 301 }
  }
  function Harness({engine = 'a', session = 'one', project = 'project'}: {engine?: string; session?: string; project?: string}) {
    const state = useEngineQuota(project, engine, session)
    return <><span>{state.quota?.engine_id}</span><button onClick={() => void state.refresh()}>refresh</button></>
  }
  try {
    await act(async () => root.render(<Harness />))
    assert.deepEqual(calls, [['project', false]])
    await act(async () => root.render(<Harness engine="b" />))
    assert.equal(container.querySelector('span')?.textContent, 'b')
    assert.equal(calls.length, 1)
    await act(async () => root.render(<Harness engine="b" session="two" />))
    assert.deepEqual(calls[1], ['project', false])
    await act(async () => container.querySelector('button')!.click())
    assert.deepEqual(calls[2], ['project', true])
    await act(async () => root.render(<Harness project="other" />))
    assert.deepEqual(calls[3], ['other', false])
  } finally {
    engineApi.quotas = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('useEngineQuota tolerates responses without an engines array without crashing', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = engineApi.quotas
  engineApi.quotas = async () => ({} as never)
  function Harness() {
    const state = useEngineQuota('project', 'codex_sdk', 's1')
    return <span data-count={state.entries.length}>{state.entries.length}</span>
  }
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(container.querySelector('[data-count]')?.textContent, '0')
  } finally {
    engineApi.quotas = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
