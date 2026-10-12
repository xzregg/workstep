import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatListTurnRefresh } from '../src/hooks/useChatListTurnRefresh'
import { useChatListStore } from '../src/stores/chatSessionStore'

test('opening and switching conversations reuse the list; finishing a turn refreshes once', async () => {
  const { window } = installDomEnvironment()
  const refresh = useChatListStore.getState().refreshSessions
  const calls: string[] = []
  useChatListStore.setState({ refreshSessions: id => { calls.push(id) } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Harness({ id, running }: { id: string; running: boolean }) {
    useChatListTurnRefresh('project', id, running)
    return null
  }
  try {
    await act(async () => root.render(<Harness id="a" running={false} />))
    await act(async () => root.render(<Harness id="a" running />))
    await act(async () => root.render(<Harness id="b" running={false} />))
    assert.deepEqual(calls, [])
    await act(async () => root.render(<Harness id="b" running />))
    await act(async () => root.render(<Harness id="b" running={false} />))
    await act(async () => root.render(<Harness id="b" running={false} />))
    assert.deepEqual(calls, ['project'])
  } finally {
    await act(async () => root.unmount())
    useChatListStore.setState({ refreshSessions: refresh })
    await window.happyDOM.close()
  }
})
