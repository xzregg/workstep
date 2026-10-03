import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import TaskConversationMessage from '../src/components/TaskConversationMessage'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { I18nProvider } from '../src/i18n'

test('task replies keep the stage avatar without a stage name beside it', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskConversationMessage
      message={{ id: 'message', role: 'assistant', channel: 'execution', step_key: 'deliver',
        content: '阶段回复', created_at: '2026-01-01T00:00:00Z' }}
      task={null} steps={[{ key: 'deliver', label: '交付', color: '#123456', prompt: '', inputs: [], outputs: [] }]}
      stepProgress={[]} reviews={[]} artifacts={[]}
      latestStepMessageIds={new Map()} latestExecutionMessageIds={new Map()}
      locale="zh-CN" canChat={false} onOpenArtifact={() => {}}
      sessionIdForStep={() => null} stepLastRef={{ current: {} }}
    /></I18nProvider>))
    assert.equal(container.querySelector('.chat-message-sender-mobile'), null)
    assert.equal(container.querySelector('.chat-message-avatar-anchor [aria-label]')?.getAttribute('aria-label'), '交付')
    assert.match(container.textContent || '', /阶段回复/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('ordinary chat replies do not show an assistant name above the content', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatMessageBubble
      role="assistant" sender="对话助手" initials="AI" color="#123456" content="正常回复"
    /></I18nProvider>))
    assert.equal(container.querySelector('.chat-message-sender-mobile'), null)
    assert.match(container.textContent || '', /正常回复/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('own task messages retain the saved author name for mobile display', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const previousName = useUserSettingsStore.getState().userName
  useUserSettingsStore.setState({ userName: '谢测试1' })
  try {
    await act(async () => root.render(<I18nProvider><TaskConversationMessage
      message={{ id: 'message', role: 'user', channel: 'execution', step_key: 'write',
        author_name: '谢测试1', content: '继续编写', created_at: '2026-01-01T00:00:00Z' }}
      task={null} steps={[{ key: 'write', label: '编写', color: '#123456', prompt: '', inputs: [], outputs: [] }]}
      stepProgress={[]} reviews={[]} artifacts={[]}
      latestStepMessageIds={new Map()} latestExecutionMessageIds={new Map()}
      locale="zh-CN" canChat={false} onOpenArtifact={() => {}}
      sessionIdForStep={() => null} stepLastRef={{ current: {} }}
    /></I18nProvider>))
    assert.equal(container.querySelector('.chat-message-sender-mobile')?.textContent, '谢测试1')
    assert.match(container.textContent || '', /@编写/)
    assert.match(container.textContent || '', /继续编写/)
  } finally {
    await act(async () => root.unmount())
    useUserSettingsStore.setState({ userName: previousName })
    await window.happyDOM.close()
  }
})
