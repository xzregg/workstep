import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskRecoveredBadge from '../src/components/TaskRecoveredBadge'
import { I18nProvider } from '../src/i18n'

test('recovered badge shows the shared compact state and recovery details', async () => {
  const window = new Window({ width: 390 })
  Object.assign(globalThis, {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskRecoveredBadge status="running" recoveredCount={2} />
        </I18nProvider>,
      )
    })

    const badge = container.querySelector<HTMLElement>('.task-recovered-badge')
    assert.equal(badge?.textContent, '断点续跑')
    assert.match(badge?.title || '', /累计 2 次/)

    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskRecoveredBadge status="done" recoveredCount={2} />
        </I18nProvider>,
      )
    })
    assert.equal(container.querySelector('.task-recovered-badge'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
