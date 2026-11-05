import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { systemSettingsApi } from '../src/api/client'
import MessageHistorySetting from '../src/components/MessageHistorySetting'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('message history settings validate size and retain a failed draft for retry', async () => {
  const { window } = installDomEnvironment()
  const original = systemSettingsApi.updateMessageHistoryPageSize
  const originalState = useUserSettingsStore.getState()
  const saved: number[] = []
  let fail = false
  systemSettingsApi.updateMessageHistoryPageSize = async depth => {
    if (fail) throw new Error('保存失败')
    saved.push(depth)
    return { message_history_page_size: depth, user_name: '', open_mode: false, default_project_directory: '' }
  }
  useUserSettingsStore.setState({ messageHistoryPageSize: 20, loaded: true, loading: false, error: '' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MessageHistorySetting /></I18nProvider>))
    const input = container.querySelector<HTMLInputElement>('#message-history-page-size')!
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!
    const change = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(input.value, '20')
    for (const value of ['', '0', '-1', '1.5', '301']) {
      await change(value)
      assert.equal(save.disabled, true)
    }
    await change('40')
    await act(async () => save.click())
    assert.deepEqual(saved, [40])
    assert.equal(useUserSettingsStore.getState().messageHistoryPageSize, 40)
    fail = true
    await change('3')
    await act(async () => save.click())
    assert.equal(input.value, '3')
    assert.equal(useUserSettingsStore.getState().messageHistoryPageSize, 40)
    assert.match(container.textContent || '', /保存失败/)
    fail = false
    await act(async () => save.click())
    assert.equal(useUserSettingsStore.getState().messageHistoryPageSize, 3)
    assert.match(container.textContent || '', /消息加载设置已保存/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    useUserSettingsStore.setState(originalState)
    systemSettingsApi.updateMessageHistoryPageSize = original
    await window.happyDOM.close()
  }
})
