import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import DigitalPersonFeedback from '../src/components/digital-person/DigitalPersonFeedback'
import { digitalRuntimeApi } from '../src/api/digitalPerson'

test('feedback failure preserves vote, exposes the cause and allows retry', async () => {
  const { window } = installDomEnvironment()
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  const original = digitalRuntimeApi.feedback
  let calls = 0
  digitalRuntimeApi.feedback = async () => { if (++calls === 1) throw new Error('服务暂不可用'); return {} as any }
  try {
    await act(async () => root.render(<I18nProvider><DigitalPersonFeedback messageId="answer" /></I18nProvider>))
    const vote = element.querySelector('button')!
    await act(async () => vote.click())
    assert.equal(vote.getAttribute('aria-pressed'), 'false')
    assert.match(element.querySelector('[role="alert"]')!.textContent!, /服务暂不可用/)
    await act(async () => vote.click())
    assert.equal(vote.getAttribute('aria-pressed'), 'true')
    assert.equal(element.querySelector('[role="alert"]'), null)
  } finally { digitalRuntimeApi.feedback = original; await act(async () => root.unmount()); await window.happyDOM.close() }
})
