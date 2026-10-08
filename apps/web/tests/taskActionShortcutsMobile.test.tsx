import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskActionButtons } from '../src/components/TaskActionShortcuts'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

test('task shortcuts use a lightning sheet on compact layouts', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const selected: string[] = []
  useLocaleStore.setState({ locale: 'zh-CN' })
  const state = {
    buttons: [
      { id: 'disabled', kind: 'prompt', label: '停用按钮', prompt: '不可触发', source: 'project', enabled: false },
      { id: 'prompt', kind: 'prompt', label: '解释代码', prompt: '请解释代码', source: 'project' },
      { id: 'restart', kind: 'action', label: '重启服务', prompt: '', action_id: 'restart', source: 'workflow' },
    ],
    runs: [], pending: null, busy: false, error: '', setPending: () => {},
    run: (button: { id: string }) => { selected.push(button.id) }, stop: () => {},
  } as unknown as Parameters<typeof TaskActionButtons>[0]['state']
  try {
    await act(async () => root.render(<I18nProvider>
      <TaskActionButtons state={state} compact onFillPrompt={(value) => selected.push(value)} />
    </I18nProvider>))
    assert.equal(container.querySelector('.chat-quick-prompts'), null)
    const bolt = container.querySelector<HTMLButtonElement>('.chat-quick-bolt')
    assert.ok(bolt)
    await act(async () => bolt.click())
    const sheet = document.querySelector<HTMLElement>('.mobile-sheet')
    assert.ok(sheet)
    assert.doesNotMatch(sheet.textContent || '', /停用按钮/)
    assert.match(sheet.textContent || '', /解释代码/)
    assert.match(sheet.textContent || '', /重启服务/)
    const prompt = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('解释代码'))!
    await act(async () => prompt.click())
    assert.deepEqual(selected, ['请解释代码'])
    assert.equal(document.querySelector('.mobile-sheet'), null)
    await act(async () => bolt.click())
    const action = [...document.querySelectorAll<HTMLButtonElement>('.mobile-sheet button')].find((button) => button.textContent?.includes('重启服务'))!
    await act(async () => action.click())
    assert.deepEqual(selected, ['请解释代码', 'restart'])
    assert.equal(document.querySelector('.mobile-sheet'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
