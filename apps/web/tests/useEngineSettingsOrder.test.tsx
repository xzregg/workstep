import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { useEngineSettingsOrder } from '../src/hooks/useEngineSettingsOrder'
import type { EngineInfo } from '../src/api/client'

function Cards({ engines, hidden, loading }: { engines: EngineInfo[]; hidden: boolean; loading: boolean }) {
  const ordered = useEngineSettingsOrder(engines, hidden, loading)
  return <div hidden={hidden}>{ordered.map(engine => <span key={engine.id} data-id={engine.id} data-enabled={engine.enabled !== false} />)}</div>
}

test('visit snapshots wait for initial data, preserve refresh order and append new IDs', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = async (items: [string, boolean][], hidden = false, loading = false) => {
    await act(async () => root.render(<Cards engines={items.map(([id, enabled]) => ({ id, enabled }) as EngineInfo)} hidden={hidden} loading={loading} />))
  }
  const ids = () => Array.from(document.querySelectorAll('[data-id]'), element => element.getAttribute('data-id'))
  try {
    await render([], false, true)
    assert.deepEqual(ids(), [])
    await render([['a', false], ['b', true], ['c', false], ['d', true]])
    assert.deepEqual(ids(), ['b', 'd', 'a', 'c'])
    await render([['c', true], ['a', true], ['d', false], ['b', false]], false, true)
    assert.deepEqual(ids(), ['b', 'd', 'a', 'c'])
    await render([['c', true], ['a', true], ['d', false], ['b', false], ['new', true]])
    assert.deepEqual(ids(), ['b', 'd', 'a', 'c', 'new'])
    await render([['new', false], ['c', true], ['b', true], ['a', true]])
    assert.deepEqual(ids(), ['b', 'a', 'c', 'new'])
    await render([['new', false], ['c', true], ['b', true], ['a', true]], true)
    await render([['new', false], ['c', true], ['b', true], ['a', true]])
    assert.deepEqual(ids(), ['c', 'b', 'a', 'new'])
    for (const enabled of [true, false]) {
      await render([], true)
      await render([['c', enabled], ['a', enabled], ['b', enabled]])
      assert.deepEqual(ids(), ['c', 'a', 'b'])
    }
    await render([], true)
    await render([])
    assert.deepEqual(ids(), [])
    await render([['a', false], ['b', true]])
    assert.deepEqual(ids(), ['a', 'b'], 'a completed empty visit also keeps later refreshes fixed')
    await render([['a', false], ['b', true]], true, true)
    await render([['a', false], ['b', true]], false, true)
    assert.deepEqual(ids(), ['b', 'a'], 'entry partitions existing cards even during a background refresh')
    await render([['a', true], ['b', false]])
    assert.deepEqual(ids(), ['b', 'a'])
    await render([], true, true)
    await render([], false, true)
    await render([['a', false], ['b', true]])
    assert.deepEqual(ids(), ['b', 'a'])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
