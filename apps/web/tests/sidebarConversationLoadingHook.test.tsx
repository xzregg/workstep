import assert from 'node:assert/strict'
import test from 'node:test'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { useSidebarConversationLoading } from '../src/hooks/useSidebarConversationLoading'
import { useChatListStore } from '../src/stores/chatSessionStore'

function Harness({ visible, ids }: { visible: boolean; ids: string[] }) {
  useSidebarConversationLoading(visible, ids)
  return null
}

test('visible expansions load once without timers, including restored desktop state and later project registration', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = useChatListStore.getState().fetchSessions
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const calls: string[] = []
  useChatListStore.setState({ fetchSessions: async (id, preserve) => {
    assert.equal(preserve, true)
    calls.push(id)
  } })
  const previousTimeout = globalThis.setTimeout, previousInterval = globalThis.setInterval
  globalThis.setTimeout = (() => { throw new Error('conversation loading must not schedule timers') }) as typeof setTimeout
  globalThis.setInterval = (() => { throw new Error('conversation loading must not poll') }) as typeof setInterval
  const render = (visible: boolean, ids: string[]) => act(async () => root.render(
    <StrictMode><Harness visible={visible} ids={ids} /></StrictMode>,
  ))
  try {
    await render(true, ['restored'])
    assert.deepEqual(calls, ['restored'])
    await render(true, ['restored'])
    await render(true, ['restored', 'registered-later'])
    assert.deepEqual(calls, ['restored', 'registered-later'])
    await render(true, ['registered-later'])
    await render(true, ['restored', 'registered-later'])
    assert.deepEqual(calls, ['restored', 'registered-later', 'restored'])
    await render(false, ['restored', 'registered-later'])
    assert.equal(calls.length, 3)
    await render(true, ['restored', 'registered-later'])
    assert.deepEqual(calls, ['restored', 'registered-later', 'restored', 'restored', 'registered-later'])
  } finally {
    globalThis.setTimeout = previousTimeout; globalThis.setInterval = previousInterval
    await act(async () => root.unmount())
    useChatListStore.setState({ fetchSessions: previousFetch })
    await window.happyDOM.close()
  }
})
