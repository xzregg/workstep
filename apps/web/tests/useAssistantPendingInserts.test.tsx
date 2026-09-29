import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { pendingMessageInsertApi } from '../src/api/client'
import { useAssistantPendingInserts } from '../src/hooks/useAssistantPendingInserts'
import { I18nProvider } from '../src/i18n'
import { usePendingMessageInsertStore } from '../src/stores/pendingMessageInsertStore'

function PendingHarness({ onSendContent, status = 'running' }: {
  onSendContent: (content: string, ids: string[]) => Promise<boolean>
  status?: 'running' | 'stopped'
}) {
  const [input, setInput] = useState('  稍后执行  ')
  const pending = useAssistantPendingInserts({
    projectId: 'project-1',
    sessionId: 'session-1',
    messages: [{ id: 'running-1', role: 'assistant', status, engine: 'claude' }],
    input,
    onInputChange: setInput,
    onSendContent,
  })
  return <>
    <button type="button" data-queue onClick={() => { void pending.queueCurrentInput() }}>排队</button>
    <span data-enabled>{String(pending.queueEnabled)}</span>
    <span data-input>{input}</span>
    <span data-error>{pending.error}</span>
    {pending.panel}
  </>
}

test('assistant pending insert stays queued after failed send and clears on success', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  const originals = { ...pendingMessageInsertApi }
  const created: Array<[string, string, string]> = []
  const removed: string[] = []
  const sent: Array<[string, string[]]> = []
  let sendSucceeds = false
  pendingMessageInsertApi.list = async () => ({ items: [] })
  pendingMessageInsertApi.create = async (projectId, targetMessageId, content) => {
    created.push([projectId, targetMessageId, content])
    return { id: 'insert-1', target_message_id: targetMessageId, content } as never
  }
  pendingMessageInsertApi.remove = async (_projectId, id) => {
    removed.push(id)
    return { deleted: true }
  }
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  try {
    await act(async () => root.render(<I18nProvider><PendingHarness onSendContent={async (content, ids) => {
      sent.push([content, ids])
      return sendSucceeds
    }} /></I18nProvider>))
    assert.equal(container.querySelector('[data-enabled]')?.textContent, 'true')
    await act(async () => (container.querySelector('[data-queue]') as HTMLButtonElement).click())
    assert.deepEqual(created, [['project-1', 'running-1', '稍后执行']])
    assert.equal(container.querySelector('[data-input]')?.textContent, '')
    const send = container.querySelector('[role="region"] button') as HTMLButtonElement
    assert.ok(send)
    assert.equal(container.querySelector('[role="region"]')?.getAttribute('style'), null)
    assert.equal(send.getAttribute('style'), null)
    assert.equal(container.querySelector('[role="region"] [style]'), null)

    await act(async () => send.click())
    assert.deepEqual(sent, [['稍后执行', ['insert-1']]])
    assert.deepEqual(removed, [])
    assert.ok(container.querySelector('[role="region"]'))

    sendSucceeds = true
    await act(async () => send.click())
    assert.deepEqual(removed, ['insert-1'])
    assert.equal(container.querySelector('[role="region"]'), null)
  } finally {
    Object.assign(pendingMessageInsertApi, originals)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('stopped assistant reply reloads its persisted pending inserts after refresh', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  const originalList = pendingMessageInsertApi.list
  const requests: Array<[string, string]> = []
  pendingMessageInsertApi.list = async (projectId, targetMessageId) => {
    requests.push([projectId, targetMessageId])
    return { items: [{
      id: 'saved-1', target_message_id: targetMessageId, content: '刷新前排队的消息',
      position: 0, username: '测试用户', created_at: '', updated_at: '',
    }] }
  }
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  try {
    await act(async () => root.render(<I18nProvider><PendingHarness
      status="stopped" onSendContent={async () => true}
    /></I18nProvider>))
    assert.deepEqual(requests, [['project-1', 'running-1']])
    assert.match(container.querySelector('[role="region"]')?.textContent || '', /刷新前排队的消息/)
    assert.equal(container.querySelector('[data-enabled]')?.textContent, 'false')
  } finally {
    pendingMessageInsertApi.list = originalList
    await act(async () => root.unmount())
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
    await window.happyDOM.close()
  }
})
