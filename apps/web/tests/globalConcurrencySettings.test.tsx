// Must stay first: react-dom snapshots DOM support during module evaluation.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { assistantApi } from '../src/api/client'
import GlobalConcurrencySettings from '../src/pages/GlobalConcurrencySettings'
import { I18nProvider, useLocaleStore } from '../src/i18n'

function setNativeValue(
  window: ReturnType<typeof installDomEnvironment>['window'],
  element: HTMLInputElement,
  value: string,
) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value)
}

test('global concurrency settings load and save task and chat limits', async () => {
  const { window } = installDomEnvironment()
  const originalGet = assistantApi.concurrencyConfig
  const originalSet = assistantApi.setConcurrencyConfig
  const saved: Array<{ max_tasks: number; max_chats: number; schedule_exempt: boolean }> = []
  assistantApi.concurrencyConfig = async () => ({
    saved: true,
    max_tasks: 3,
    max_chats: 5,
    schedule_exempt: false,
  })
  assistantApi.setConcurrencyConfig = async (config) => {
    saved.push(config)
    return { saved: true, ...config }
  }
  useLocaleStore.setState({ locale: 'zh-CN' })

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <GlobalConcurrencySettings />
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })

    const taskInput = container.querySelector<HTMLInputElement>('#global-max-tasks')
    const chatInput = container.querySelector<HTMLInputElement>('#global-max-chats')
    const exemptInput = container.querySelector<HTMLInputElement>('#global-schedule-exempt')
    assert.equal(taskInput?.value, '3')
    assert.equal(chatInput?.value, '5')
    assert.equal(taskInput?.type, 'text')
    assert.equal(taskInput?.inputMode, 'numeric')
    assert.equal(taskInput?.pattern, '[1-9][0-9]*')
    assert.equal(taskInput?.list, null)
    assert.equal(exemptInput?.checked, false)

    await act(async () => {
      setNativeValue(window, taskInput!, '2')
      taskInput!.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(window, chatInput!, '4')
      chatInput!.dispatchEvent(new Event('input', { bubbles: true }))
      exemptInput!.click()
    })
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '保存')
    assert.ok(saveButton)
    await act(async () => saveButton.click())

    assert.deepEqual(saved, [{ max_tasks: 2, max_chats: 4, schedule_exempt: true }])
    assert.match(container.textContent || '', /已保存/)

    await act(async () => {
      setNativeValue(window, taskInput!, 'abc')
      taskInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(taskInput?.value, '2')

    await act(async () => {
      setNativeValue(window, taskInput!, '')
      taskInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(taskInput?.value, '不限制')

    await act(async () => {
      setNativeValue(window, taskInput!, '0')
      taskInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(taskInput?.value, '不限制')
  } finally {
    assistantApi.concurrencyConfig = originalGet
    assistantApi.setConcurrencyConfig = originalSet
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
