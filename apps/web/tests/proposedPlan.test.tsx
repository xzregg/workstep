import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { I18nProvider } from '../src/i18n'
import { latestMarkdownPlanFromEvents } from '../src/utils/plan'

test('uses the final markdown plan snapshot, not the execution checklist', () => {
  const events = [
    { type: 'CUSTOM', name: 'workstep.plan', value: { entries: [{ content: '检查', status: 'completed' }] } },
    { type: 'CUSTOM', name: 'workstep.plan_update', value: { id: 'p1', type: 'markdown', content: '# 方案\n草稿' } },
    { type: 'CUSTOM', name: 'workstep.plan_update', value: { id: 'p1', type: 'markdown', content: '# 方案\n最终正文', complete: true } },
  ]
  assert.equal(latestMarkdownPlanFromEvents(events)?.content, '# 方案\n最终正文')
  assert.equal(latestMarkdownPlanFromEvents(events.slice(0, 1)), undefined)
})

test('renders a completed proposal even when the assistant has no ordinary reply', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatMessageBubble
          role="assistant" sender="Codex" initials="AI" color="var(--ai-assistant)"
          content=""
          events={[{ type: 'CUSTOM', name: 'workstep.plan_update', value: {
            id: 'p1', type: 'markdown', content: '# 完整方案\n实施说明', complete: true,
          } }]}
        />
      </I18nProvider>,
    ))
    assert.match(window.document.body.textContent || '', /完整方案/)
    assert.match(window.document.body.textContent || '', /实施说明/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
