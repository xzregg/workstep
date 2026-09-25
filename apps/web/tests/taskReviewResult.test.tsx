import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import type { ReviewRun } from '../src/api/client'
import TaskReviewResult from '../src/components/TaskReviewResult'

test('review result shows status and gates decision controls by actionability', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const review = { mode: 'manual', status: 'pending', report: null, decision: null } as ReviewRun
  const render = (actionable: boolean) => <I18nProvider><TaskReviewResult review={review}
    actionable={actionable} onAction={() => {}} /></I18nProvider>
  try {
    await act(async () => root.render(render(false)))
    assert.equal(container.querySelector('.status-badge')?.getAttribute('data-s'), 'paused')
    assert.equal(container.querySelector('textarea'), null)
    await act(async () => root.render(render(true)))
    assert.ok(container.querySelector('textarea'))
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
