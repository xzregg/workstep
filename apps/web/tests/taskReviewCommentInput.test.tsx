import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskReviewCommentInput from '../src/components/TaskReviewCommentInput'

test('clear empties the controlled review input and preserves new edits across rerenders', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness() {
    const [value, setValue] = useState('完整审核正文')
    return <TaskReviewCommentInput value={value} onChange={setValue} />
  }
  const render = async () => act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
  try {
    await render()
    const clear = container.querySelector<HTMLButtonElement>('button')!
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!
    assert.equal(clear.textContent, '清除')
    assert.equal(clear.type, 'button')
    assert.equal(clear.compareDocumentPosition(input) & 4, 4)
    await act(async () => clear.click())
    assert.equal(input.value, '')
    await render()
    assert.equal(input.value, '')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '重新填写')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await render()
    assert.equal(input.value, '重新填写')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
