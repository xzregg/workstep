import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ReviewDecisionActions from '../src/components/ReviewDecisionActions'
import { I18nProvider } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

test('manual review offers set complete immediately after terminate', async () => {
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
      '终止任务', '完成步骤', '驳回重做', '通过继续',
    ])
    assert.ok(buttons[1].classList.contains('review-decision-complete'))
    assert.ok(buttons[2].classList.contains('review-decision-reject'))
    await act(async () => buttons[1].click())
    assert.deepEqual(decisions, ['set-complete'])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('share review hides unsupported step completion while retaining review decisions', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ReviewDecisionActions status="pending" pending={false}
      canCompleteStep={false} onAction={() => {}} /></I18nProvider>))
    assert.deepEqual(Array.from(document.querySelectorAll('button')).map(button => button.textContent?.trim()),
      ['终止任务', '驳回重做', '通过继续'])
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
