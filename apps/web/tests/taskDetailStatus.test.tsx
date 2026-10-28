import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskDetailHeader from '../src/components/TaskDetailHeader'

test('detail header explains review waits instead of showing the pipeline pause', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const cases = [
    { steps: [{ status: 'awaiting_review' }], completed: false, expected: '等待审核' },
    { steps: [{ status: 'reviewing' }], completed: false, expected: '审核中' },
    { steps: [], completed: false, expected: '失败' },
    { steps: [{ status: 'passed' }], completed: true, expected: '已完成' },
  ]
  try {
    for (const item of cases) {
      await act(async () => root.render(<I18nProvider><TaskDetailHeader
        task={{ id: 'remote-task', title: '审核状态', status: 'paused', steps: item.steps as any, created_at: '2026-01-01T00:00:00Z' }}
        locale="zh-CN" activeStep={{ key: 'review', label: '验收', color: 'blue', prompt: '', inputs: [], outputs: [] }}
        activeStepColor="blue" taskCompleted={item.completed} />
      </I18nProvider>))
      assert.equal(container.querySelector('[data-status]')?.textContent, item.expected)
    }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
