import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ChatMessageBubble, { type ChatMessageBubbleProps } from '../src/components/ChatMessageBubble'
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

test('renders literal proposal envelopes as a card, preserves trailing text and prefers native events', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const content = '<proposed_plan>\n# 数字人持续跟进委派\n\n- 新委派默认跟进\n</proposed_plan>\n后续说明'
  const render = (role: 'user' | 'assistant', events: ChatMessageBubbleProps['events'] = []) => act(async () => root.render(
    <I18nProvider><ChatMessageBubble role={role} sender="Codex" initials="AI" color="blue" content={content} events={events} /></I18nProvider>,
  ))
  try {
    await render('assistant')
    assert.equal(host.querySelectorAll('.chat-proposed-plan').length, 1)
    assert.equal(host.querySelector('.chat-proposed-plan h1')?.textContent, '数字人持续跟进委派')
    assert.equal(host.querySelectorAll('li').length, 1)
    assert.ok(host.textContent?.includes('后续说明'))
    assert.ok(!host.textContent?.includes('<proposed_plan>'))
    await render('assistant', [{ type: 'TEXT_MESSAGE_CHUNK', delta: content }])
    assert.equal(host.querySelectorAll('.chat-proposed-plan').length, 1)
    assert.ok(!host.textContent?.includes('<proposed_plan>'))
    await render('assistant', [{ type: 'CUSTOM', name: 'workstep.plan_update', value: {
      id: 'native', type: 'markdown', content: '# 权威计划', complete: true,
    } }])
    assert.equal(host.querySelectorAll('.chat-proposed-plan').length, 1)
    assert.equal(host.querySelector('.chat-proposed-plan h1')?.textContent, '权威计划')
    assert.ok(host.textContent?.includes('后续说明'))
    await render('user')
    assert.equal(host.querySelector('.chat-proposed-plan'), null)
    assert.ok(host.textContent?.includes('<proposed_plan>'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

for (const withEvents of [false, true]) test(`streamed delimiters preserve live text nodes and stream end keeps the card (events=${withEvents})`, async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const render = (content: string, streaming = true) => act(async () => root.render(
    <I18nProvider><ChatMessageBubble role="assistant" sender="Codex" initials="AI" color="blue" content={content} streaming={streaming}
      events={withEvents && content ? [{ type: 'TEXT_MESSAGE_CHUNK', delta: content }] : []} /></I18nProvider>,
  ))
  const advance = async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 110)) })
  }
  try {
    await render('')
    await render('<proposed_')
    assert.equal(host.querySelector('.markdown-message')?.textContent, '')
    await render('<proposed_plan>')
    const card = host.querySelector('.chat-proposed-plan')
    assert.ok(card)
    await render('<proposed_plan>\n已有正文')
    for (let i = 0; i < 4; i++) await advance()
    const paragraph = card.querySelector('p'), node = paragraph?.firstChild
    assert.equal(paragraph?.textContent, '已有正文')
    await render('<proposed_plan>\n已有正文继续追加')
    assert.equal(paragraph?.textContent, '已有正文')
    for (let i = 0; i < 4; i++) await advance()
    assert.equal(paragraph?.textContent, '已有正文继续追加')
    assert.ok(paragraph?.firstChild === node, 'appends preserve the native text node')
    await render('<proposed_plan>\n已有正文继续追加\n</proposed_')
    await advance()
    const beforeClose = paragraph?.firstChild
    await render('<proposed_plan>\n已有正文继续追加\n</proposed_plan>')
    assert.ok(paragraph?.firstChild === beforeClose, 'completing the tag preserves live text')
    await render('<proposed_plan>\n已有正文继续追加\n</proposed_plan>', false)
    await advance()
    assert.ok(host.querySelector('.chat-proposed-plan') === card, 'card stays mounted')
    assert.ok(card.querySelector('p') === paragraph, 'paragraph stays mounted')
    assert.equal(paragraph?.textContent, '已有正文继续追加')
    assert.ok(!card.textContent?.includes('proposed_'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
