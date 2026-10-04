import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatSessionRenameDialog from '../src/components/ChatSessionRenameDialog'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatListStore } from '../src/stores/chatSessionStore'

test('session rename owns validation, retry and list update', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  const originalRename = chatSessionApi.rename
  useChatListStore.setState({
    sessionsByProject: { p1: [{ id: 's1', project_id: 'p1', title: '旧标题' }] as never },
  })
  let calls = 0
  let renamed = ''
  chatSessionApi.rename = async (_sessionId, _projectId, title) => {
    calls += 1
    if (calls === 1) throw new Error('暂时不可用')
    return { title } as never
  }
  try {
    await act(async () => root.render(<I18nProvider>
      <ChatSessionRenameDialog
        projectId="p1"
        sessionId="s1"
        title="旧标题"
        onRenamed={(title) => { renamed = title }}
        onClose={() => {}}
      />
    </I18nProvider>))
    const input = container.querySelector('input') as HTMLInputElement
    const save = container.querySelector('.btn-primary') as HTMLButtonElement
    assert.ok(input)
    assert.ok(save)
    assert.equal(input.value, '旧标题')

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    assert.ok(setter)
    await act(async () => {
      setter.call(input, '   ')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(save.disabled, true)
    assert.equal(calls, 0)

    await act(async () => {
      setter.call(input, '新标题')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(save.disabled, false)
    await act(async () => save.click())
    assert.match(container.textContent || '', /暂时不可用/)
    await act(async () => save.click())
    assert.equal(calls, 2)
    assert.equal(renamed, '新标题')
    assert.equal(useChatListStore.getState().sessionsByProject.p1[0].title, '新标题')
  } finally {
    chatSessionApi.rename = originalRename
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
