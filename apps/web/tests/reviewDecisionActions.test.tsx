import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ReviewDecisionActions from '../src/components/ReviewDecisionActions'
import { I18nProvider } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

test('manual review places complete task immediately after terminate', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const decisions: string[] = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ReviewDecisionActions status="pending" pending={false} onAction={(decision) => decisions.push(decision)} />
      </I18nProvider>,
    ))
    const buttons = Array.from(window.document.querySelectorAll('button'))
    assert.deepEqual(buttons.map((button) => button.textContent?.trim()), [
      '终止任务', '完成任务', '驳回并重启步骤', '通过并进入下一步骤',
    ])
    await act(async () => buttons[1].click())
    assert.deepEqual(decisions, ['complete-task'])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
