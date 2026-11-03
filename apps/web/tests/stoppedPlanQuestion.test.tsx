import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import AssistantChatPanel from '../src/components/AssistantChatPanel'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

for (const cancelled of [false, true]) {
  test(`stopped plan question resumes as a new message (cancelled=${cancelled})`, async () => {
    const { window } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const sent: string[] = []
    const events = [{ type: 'CUSTOM', name: 'workstep.interaction_request', value: {
      interaction_id: 'question', method: 'elicitation/create', message: '选择存储方案',
      requested_schema: { type: 'object', required: ['storage'], properties: {
        storage: { type: 'string', title: '存储方案', enum: ['本地文件', '数据库'] },
      } },
    } }, ...(cancelled ? [{ type: 'CUSTOM', name: 'workstep.interaction_response', value: {
      interaction_id: 'question', response: { action: 'cancel' },
    } }] : [])]
    const render = (status: 'running' | 'stopped', laterMessage = false) => root.render(
      <I18nProvider><AssistantChatPanel projectId="" title="Chat" messages={[
        { id: 'plan', role: 'assistant', content: '', status, events },
        ...(laterMessage ? [{ id: 'answer', role: 'user' as const, content: '继续', status: 'succeeded' as const }] : []),
      ]} running={status === 'running'} stopping={false} input="草稿" locale="zh-CN" config={{} as never}
        copy={{ emptyIntro: '', thinking: '', me: '用户', meInitials: 'U', agent: '助手', agentInitials: 'AI', placeholder: '', fullPrompt: '', closePrompt: '' }}
        attachmentPrefix="test" onInputChange={() => {}} onSend={() => {}} onStop={() => {}}
        onSendContent={async content => { sent.push(content); return true }}
      /></I18nProvider>)
    const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
    try {
      if (!cancelled) {
        await act(async () => render('running'))
        await act(async () => button('本地文件')!.click())
      }
      await act(async () => render('stopped'))
      assert.ok(button('本地文件'), 'stopping must keep the unanswered form available')
      if (cancelled) await act(async () => button('本地文件')!.click())
      assert.equal(button('本地文件')!.getAttribute('aria-pressed'), 'true')
      await act(async () => button('提交回答')!.click())
      assert.equal(sent.length, 1)
      assert.match(sent[0], /选择存储方案/)
      assert.match(sent[0], /存储方案.*本地文件/)
      assert.equal(button('提交回答'), undefined)
      await act(async () => render('stopped', true))
      assert.equal(button('本地文件'), undefined, 'old questions stay closed after a later message')
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}

test('stopped question recovery excludes approvals and answered questions, and allows retry', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let attempts = 0
  const request = (id: string, method: string) => ({ type: 'CUSTOM', name: 'workstep.interaction_request', value: {
    interaction_id: id, method, message: id,
    requested_schema: { properties: { answer: { type: 'string', enum: ['继续规划'] } }, required: ['answer'] },
    tool_call: { title: '敏感操作审批' },
  } })
  try {
    await act(async () => root.render(<I18nProvider><ChatMessageBubble role="assistant" sender="助手"
      content="" interactionsEnabled={false} events={[
        request('permission', 'session/request_permission'),
        request('answered', 'elicitation/create'),
        { type: 'CUSTOM', name: 'workstep.interaction_response', value: { interaction_id: 'answered', response: { action: 'accept' } } },
        request('unanswered', 'elicitation/create'),
      ]} onInteractionRespond={async () => { assert.fail('expired interaction must not be used') }}
      onInterruptedQuestionSubmit={async () => ++attempts > 1}
    /></I18nProvider>))
    assert.equal(document.body.textContent?.includes('敏感操作审批'), false)
    assert.equal(document.body.textContent?.includes('unanswered'), true)
    assert.equal(document.querySelectorAll('button[aria-pressed]').length, 1)
    const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!
    await act(async () => button('继续规划').click())
    await act(async () => button('提交回答').click())
    assert.equal(attempts, 1)
    assert.equal(button('继续规划').getAttribute('aria-pressed'), 'true')
    await act(async () => button('提交回答').click())
    assert.equal(attempts, 2)
    assert.equal(document.querySelectorAll('button[aria-pressed]').length, 0)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
