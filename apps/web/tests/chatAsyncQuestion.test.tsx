import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { I18nProvider } from '../src/i18n'

test('Codex asynchronous question submits a choice without changing the draft', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const drafts: string[] = []
  const submitted: string[] = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatMessageBubble
          role="assistant"
          sender="Codex"
          initials="AI"
          color="var(--ai-assistant)"
          content="请选择处理方式"
          events={[{
            type: 'CUSTOM', name: 'workstep.async_question',
            value: {
              source_item_id: 'call-1',
              questions: [{ title: '处理方式？', options: ['复制差异块', '逐行复制'] }],
            },
          }]}
          onSendToInput={(value) => drafts.push(value)}
          onAsyncQuestionSubmit={async (value) => { submitted.push(value); return true }}
        />
      </I18nProvider>,
    ))
    const button = Array.from(window.document.querySelectorAll('button'))
      .find((node) => node.textContent === '复制差异块')
    assert.ok(button)
    await act(async () => button.click())
    assert.deepEqual(submitted, ['复制差异块'])
    assert.deepEqual(drafts, [])
    assert.equal(button.disabled, true)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('selections from multiple questions submit together after the final choice', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const drafts: string[] = []
  const submitted: string[] = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatMessageBubble
          role="assistant" sender="Codex" initials="AI" color="var(--ai-assistant)"
          content="请选择"
          events={[{
            type: 'CUSTOM', name: 'workstep.async_question',
            value: { source_item_id: 'call-2', questions: [
              { title: '范围？', options: ['前端'] },
              { title: '测试？', options: ['需要'] },
            ] },
          }]}
          onSendToInput={(value) => drafts.push(value)}
          onAsyncQuestionSubmit={async (value) => { submitted.push(value); return true }}
        />
      </I18nProvider>,
    ))
    const buttons = Array.from(window.document.querySelectorAll('button'))
    await act(async () => buttons.find((button) => button.textContent === '前端')?.click())
    await act(async () => buttons.find((button) => button.textContent === '需要')?.click())
    assert.deepEqual(submitted, ['范围？：前端\n测试？：需要'])
    assert.deepEqual(drafts, [])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('failed asynchronous question submission can be retried', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const submitted: string[] = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatMessageBubble
          role="assistant" sender="Codex" initials="AI" color="var(--ai-assistant)"
          content="请选择"
          events={[{
            type: 'CUSTOM', name: 'workstep.async_question',
            value: { source_item_id: 'call-3', questions: [
              { title: '处理方式？', options: ['自动中止合并'] },
            ] },
          }]}
          onAsyncQuestionSubmit={async (value) => {
            submitted.push(value)
            return submitted.length > 1
          }}
        />
      </I18nProvider>,
    ))
    const button = Array.from(window.document.querySelectorAll('button'))
      .find((node) => node.textContent === '自动中止合并')
    assert.ok(button)
    await act(async () => button.click())
    assert.equal(button.disabled, false)
    await act(async () => button.click())
    assert.deepEqual(submitted, ['自动中止合并', '自动中止合并'])
    assert.equal(button.disabled, true)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
