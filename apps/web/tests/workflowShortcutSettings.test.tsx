import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import WorkflowShortcutSettingsDialog from '../src/components/WorkflowShortcutSettingsDialog'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('workflow shortcut settings lists project buttons with individual use checkboxes', async () => {
  const { window } = installDomEnvironment()
  const original = chatSessionApi.quickButtons
  chatSessionApi.quickButtons = async () => ({ buttons: [
    { id: 'restart', label: '重启服务', prompt: '', kind: 'action' },
    { id: 'docs', label: '文档', prompt: '打开文档', kind: 'prompt' },
  ] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let saved: string[] | null = null
  useLocaleStore.setState({ locale: 'zh-CN' })
  try {
    await act(async () => root.render(<I18nProvider>
      <WorkflowShortcutSettingsDialog
        projectId="project-1"
        workflowId="workflow-1"
        workflowName="研发流程"
        selectedIds={['restart']}
        inheritByDefault
        workflowButtons={[{ id: 'workflow-link', label: '开发地址', prompt: '', content: '<a href="http://localhost:5173">前端</a>', kind: 'display' }]}
        onSave={async (ids, buttons) => { saved = ids; assert.equal(buttons[0].content, '<a href="http://localhost:5173">前端</a>') }}
        onClose={() => {}}
      />
    </I18nProvider>))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    assert.match(dialog.textContent || '', /快捷按钮/)
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    assert.equal(boxes.length, 2)
    assert.equal(boxes[0].checked, true)
    assert.equal(boxes[1].checked, false)
    const projectButtons = dialog.querySelector<HTMLElement>('[data-testid="project-quick-buttons"]')!
    assert.equal(projectButtons.style.display, 'flex')
    assert.equal(projectButtons.style.flexWrap, 'wrap')
    assert.equal(projectButtons.querySelector('label')?.style.display, 'inline-flex')
    assert.ok(dialog.querySelector('[data-testid="quick-button-list"]'))
    assert.equal(dialog.querySelector<HTMLTextAreaElement>('[data-testid="quick-button-display-content"]')?.value, '<a href="http://localhost:5173">前端</a>')
    await act(async () => boxes[1].click())
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!
    assert.ok(save, [...dialog.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.textContent).join('|'))
    await act(async () => save.click())
    assert.deepEqual(saved, ['restart', 'docs'])
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.quickButtons = original
    container.remove()
    await window.happyDOM.close()
  }
})

test('workflow shortcut settings leaves project buttons unchecked when inheritance is not configured', async () => {
  const { window } = installDomEnvironment()
  const original = chatSessionApi.quickButtons
  chatSessionApi.quickButtons = async () => ({ buttons: [
    { id: 'restart', label: '重启服务', prompt: '', kind: 'action' },
  ] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  useLocaleStore.setState({ locale: 'zh-CN' })
  try {
    await act(async () => root.render(<I18nProvider>
      <WorkflowShortcutSettingsDialog
        projectId="project-1" workflowId="workflow-1" workflowName="新流程"
        inheritByDefault={false} workflowButtons={[]}
        onSave={async () => {}} onClose={() => {}}
      />
    </I18nProvider>))
    const checkbox = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')
    assert.ok(checkbox)
    assert.equal(checkbox.checked, false)
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.quickButtons = original
    container.remove()
    await window.happyDOM.close()
  }
})
