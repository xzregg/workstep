import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { systemSettingsApi } from '../src/api/client'
import GitScanSettings from '../src/pages/GitScanSettings'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('Git settings validate depth and save globally without losing a failed draft', async () => {
  const { window } = installDomEnvironment()
  const original = systemSettingsApi.updateGitScanDepth
  const originalState = useUserSettingsStore.getState()
  const saved: number[] = []
  let fail = false
  systemSettingsApi.updateGitScanDepth = async depth => {
    if (fail) throw new Error('保存失败')
    saved.push(depth)
    return { git_scan_depth: depth, user_name: '', open_mode: false, default_project_directory: '' }
  }
  useUserSettingsStore.setState({ gitScanDepth: 5, loaded: true, loading: false, error: '' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitScanSettings /></I18nProvider>))
    const input = container.querySelector<HTMLInputElement>('#git-scan-depth')!
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!
    const change = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    assert.equal(input.value, '5')
    for (const value of ['', '-1', '1.5']) {
      await change(value)
      assert.equal(save.disabled, true)
    }
    await change('0')
    await act(async () => save.click())
    assert.deepEqual(saved, [0])
    assert.equal(useUserSettingsStore.getState().gitScanDepth, 0)
    fail = true
    await change('3')
    await act(async () => save.click())
    assert.equal(input.value, '3')
    assert.equal(useUserSettingsStore.getState().gitScanDepth, 0)
    assert.match(container.textContent || '', /保存失败/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    useUserSettingsStore.setState(originalState)
    systemSettingsApi.updateGitScanDepth = original
    await window.happyDOM.close()
  }
})
