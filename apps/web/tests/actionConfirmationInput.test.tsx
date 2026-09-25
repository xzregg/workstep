// Must stay first: react-dom snapshots DOM support during module evaluation.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskActionButtons } from '../src/components/TaskActionShortcuts'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('Action confirmation collects required text and passes it to the runner', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const calls: unknown[][] = []
  const button = {
    id: 'commit', kind: 'action', label: '提交并推送', prompt: '',
    action_id: 'commit', script_path: 'commit.sh', source: 'workflow',
    confirmation_input_prompt: '请输入 Commit 消息',
  }
  const state = {
    buttons: [button], runs: [], pending: button, busy: false, error: '',
    setPending: () => {}, run: (...args: unknown[]) => { calls.push(args) }, stop: () => {},
  } as unknown as Parameters<typeof TaskActionButtons>[0]['state']
  useLocaleStore.setState({ locale: 'zh-CN' })
  try {
    await act(async () => root.render(<I18nProvider><TaskActionButtons state={state} /></I18nProvider>))
    const input = document.querySelector<HTMLInputElement>('[data-testid="action-confirmation-input"]')
    assert.ok(input)
    assert.equal(input.placeholder, '请输入 Commit 消息')
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((item) => item.textContent?.includes('确认执行'))!
    assert.equal(confirm.disabled, true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'feat: add action input')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(confirm.disabled, false)
    await act(async () => confirm.click())
    assert.deepEqual(calls, [[button, true, 'feat: add action input']])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
