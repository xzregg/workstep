import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

function DraftHarness({ sessionId, taskId }: { sessionId: string; taskId?: string }) {
  const [value, setValue] = useState('')
  return <I18nProvider>
    <ChatInput value={value} onChange={setValue} onSend={() => {}} sessionId={sessionId} taskId={taskId} />
    <button type="button" onClick={() => setValue('任务 B 编辑中')}>编辑草稿</button>
  </I18nProvider>
}

test('composer draft follows task ownership across switches and persists on unmount', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  window.localStorage.setItem('workstep-chat-draft:session-a', '会话草稿')
  window.localStorage.setItem('workstep-task-draft:task-a', '任务 A 草稿')
  try {
    await act(async () => root.render(<DraftHarness sessionId="session-a" />))
    assert.equal(container.querySelector('textarea')?.value, '会话草稿')

    await act(async () => root.render(<DraftHarness sessionId="session-a" taskId="task-a" />))
    assert.equal(container.querySelector('textarea')?.value, '任务 A 草稿')
    assert.equal(window.localStorage.getItem('workstep-chat-draft:session-a'), '会话草稿')

    await act(async () => root.render(<DraftHarness sessionId="session-a" taskId="task-b" />))
    assert.equal(container.querySelector('textarea')?.value, '')
    assert.equal(window.localStorage.getItem('workstep-task-draft:task-a'), '任务 A 草稿')

    const edit = [...container.querySelectorAll('button')].find((button) => button.textContent === '编辑草稿')
    assert.ok(edit)
    await act(async () => edit.click())
    await act(async () => root.unmount())
    assert.equal(window.localStorage.getItem('workstep-task-draft:task-b'), '任务 B 编辑中')
  } finally {
    await window.happyDOM.close()
  }
})

test('prefilled onboarding draft survives rerenders before controlled value echoes', async () => {
 const { window } = installDomEnvironment()
 const root = createRoot(document.body.appendChild(document.createElement('div')))
 localStorage.setItem('workstep-chat-draft:onboarding', '接入文字模板')
 try {
  await act(async () => root.render(<I18nProvider><ChatInput sessionId="onboarding" value="" onChange={() => {}} onSend={() => {}} /></I18nProvider>))
  await act(async () => root.render(<I18nProvider><ChatInput sessionId="onboarding" value="" onChange={() => {}} onSend={() => {}} /></I18nProvider>))
  assert.equal(localStorage.getItem('workstep-chat-draft:onboarding'), '接入文字模板')
  await act(async () => root.unmount())
  assert.equal(localStorage.getItem('workstep-chat-draft:onboarding'), '接入文字模板')
 } finally { await window.happyDOM.close() }
})
