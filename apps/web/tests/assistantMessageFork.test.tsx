import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantChatPanel from '../src/components/AssistantChatPanel'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { chatSessionApi } from '../src/api/client'
import { useChatSessionTransitions } from '../src/hooks/useChatSessionTransitions'
import { createAssistantStore } from '../src/stores/assistantStore'
import { installDomEnvironment } from './helpers/domEnv'

for (const [status, running, content] of [
  ['error', false, ''], ['error', false, '已完成部分检查'], ['succeeded', true, '之前已完成的回复'], ['succeeded', true, ''],
] as const) {
  test(`failed reply can fork with smart handoff (${status}, ${running ? 'source running' : content || 'empty'})`, async () => {
    const { window } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    const originalFork = chatSessionApi.fork
    const routes: string[] = []
    const requests: Array<{ fork_message_id?: string; context_mode: string }> = []
    function Harness() {
      const controls = useChatSessionTransitions({
        project: { id: '', routeName: 'Project' }, sessionId: 'source', sessionTitle: 'Source',
        messageIds: ['failed-message'], running,
        current: { engine: 'codex_sdk', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
        defaultEngine: 'codex_sdk', engines: [{ id: 'codex_sdk', supports_session_fork: true }] as never,
        providers: [], permissionMode: '', onHandoffApplied: () => {}, navigate: path => routes.push(path),
      })
      return <>
        <AssistantChatPanel projectId="" title="Chat" messages={[{
          id: 'failed-message', role: 'assistant', content, status, error: status === 'error' ? '达到用量上限' : undefined,
        }]} running={running} stopping={false} input="" locale="zh-CN" config={{} as never}
          copy={{ emptyIntro: '', thinking: '', me: '用户', meInitials: 'U', agent: '助手', agentInitials: 'AI', placeholder: '', fullPrompt: '', closePrompt: '' }}
          attachmentPrefix="test" onInputChange={() => {}} onSend={() => {}}
          onSendContent={async () => true} onStop={() => {}}
          onForkMessage={(id, preferSmart) => controls.openFork('codex_sdk', id, preferSmart)}
        />
        {controls.dialogs}
      </>
    }
    try {
      chatSessionApi.fork = async (_id, input) => {
        requests.push(input)
        return { id: 'branch', project_id: '', title: input.title } as never
      }
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      if (status === 'error') assert.match(window.document.body.textContent || '', /达到用量上限/)
      const fork = window.document.querySelector<HTMLButtonElement>('[aria-label="分叉"]')
      assert.ok(fork, 'failed messages must expose a fork button')
      await act(async () => fork.click())
      assert.equal(window.document.querySelector<HTMLInputElement>('input[value="smart"]')?.checked, true)
      await act(async () => window.document.querySelector<HTMLButtonElement>('[role="dialog"] .btn-primary')!.click())
      assert.equal(requests[0].fork_message_id, 'failed-message')
      assert.equal(requests[0].context_mode, 'smart')
      assert.deepEqual(routes, ['/chat?project=Project&session=branch'])
    } finally {
      await act(async () => root.unmount())
      chatSessionApi.fork = originalFork
      await window.happyDOM.close()
    }
  })
}

test('an error without START remains visible after a content-less END', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  const emit = (event: Record<string, unknown>) => store.getState().handleWsEvent({
    channel: 'session_chat', session_id: 'source', messageId: 'failed', ...event,
  } as never)
  emit({ type: 'CUSTOM', name: 'workstep.error', value: { message: '模型调用失败' } })
  emit({ type: 'TEXT_MESSAGE_END' })
  const message = store.getState().sessions.source.messages[0]
  assert.equal(message.role, 'assistant')
  assert.equal(message.status, 'error')
  assert.equal(message.error, '模型调用失败')
})
