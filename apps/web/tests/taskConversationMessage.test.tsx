import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskConversationMessage from '../src/components/TaskConversationMessage'

test('a task user message keeps its content and last-message step anchor', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const lastMessages: Record<string, HTMLDivElement | null> = {}
  try {
    await act(async () => root.render(<I18nProvider><TaskConversationMessage
      message={{ id: 'message', role: 'user', channel: 'execution', step_key: 'build',
        content: 'Please build this', created_at: '2026-01-01T00:00:00Z' }}
      task={null} steps={[{ key: 'build', label: 'Build', color: '#123456',
        prompt: '', inputs: [], outputs: [] }]}
      stepProgress={[]} reviews={[]} artifacts={[]}
      latestStepMessageIds={new Map()} latestExecutionMessageIds={new Map()}
      locale="en-US" canChat={false} onOpenArtifact={() => {}}
      sessionIdForStep={() => null} stepLastRef={{ current: lastMessages }}
    /></I18nProvider>))
    assert.match(container.textContent || '', /Please build this/)
    assert.equal(container.querySelector('[data-step-last-message="build"]'), lastMessages.build)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
