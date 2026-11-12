import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ArchivedChatPreview, { loadArchivedExchange } from '../src/components/ArchivedChatPreview'
import { chatSessionApi, type WorkflowGenHistoryMessage } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'

const message = (id: string, role: 'user' | 'assistant'): WorkflowGenHistoryMessage => ({
  id, role, content: id, status: 'succeeded',
})
const detail = (messages: WorkflowGenHistoryMessage[]) => ({
  id: 's', title: 's', project_id: 'p', workflow_id: '', engine: 'codex', message_count: 52, messages,
})

test('archive preview finds the last question across history pages and cancels further reads', async () => {
  const original = chatSessionApi.get
  const offsets: number[] = []
  let cancelled = false
  chatSessionApi.get = async (_id, _project, limit, offset) => {
    assert.equal(limit, 50)
    offsets.push(offset!)
    return detail(offset === 0
      ? Array.from({ length: 50 }, (_, i) => message(`reply-${i}`, 'assistant'))
      : [message('previous-reply', 'assistant'), message('question', 'user')])
  }
  try {
    const result = await loadArchivedExchange('p', 's', () => cancelled)
    assert.deepEqual(offsets, [0, 50])
    assert.equal(result[0].content, 'question')
    assert.equal(result.length, 51)
    chatSessionApi.get = async () => { cancelled = true; return detail([message('late', 'user')]) }
    assert.deepEqual(await loadArchivedExchange('p', 's', () => cancelled), [])
    cancelled = false
    chatSessionApi.get = async () => detail([message('orphan-reply', 'assistant')])
    assert.deepEqual(await loadArchivedExchange('p', 's', () => cancelled), [])
  } finally { chatSessionApi.get = original }
})

test('archive preview can retry errors and shows an unanswered last question', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const original = chatSessionApi.get
  let calls = 0
  chatSessionApi.get = async () => {
    if (++calls === 1) throw new Error('读取失败')
    return detail([message('previous-reply', 'assistant'), message('待回复的问题', 'user')])
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ArchivedChatPreview projectId="p" sessionId="s" /></I18nProvider>))
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /读取失败/)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(calls, 2)
    assert.match(container.textContent || '', /待回复的问题/)
    assert.match(container.textContent || '', /暂无回复/)
    assert.doesNotMatch(container.textContent || '', /previous-reply/)
  } finally {
    chatSessionApi.get = original
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
