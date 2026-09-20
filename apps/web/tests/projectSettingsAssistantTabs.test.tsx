// Must stay first: react-dom snapshots DOM support during module evaluation.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { chatSessionApi, projectApi, type Project } from '../src/api/client'
import ProjectSettingsPanel from '../src/components/ProjectSettingsPanel'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useChatListStore } from '../src/stores/chatSessionStore'

const project: Project = {
  id: 'project-1',
  name: 'demo',
  path: '/tmp/demo',
  steps: [],
  workflows: [],
}

test('system prompt and reorderable quick buttons use separate settings tabs', async () => {
  const { window } = installDomEnvironment()
  const originalSettings = projectApi.settings
  const originalSaveQuickButtons = chatSessionApi.saveQuickButtons
  projectApi.settings = async () => ({
    name: project.name,
    path: project.path,
    chat_system_prompt: '你是助手',
    quick_buttons: [
      { id: 'explain', label: '解释', prompt: '请解释' },
      { id: 'tests', label: '写测试', prompt: '请写测试' },
    ],
    concurrency: {
      global: { max_tasks: 0, max_chats: 0, schedule_exempt: false },
      project: { max_tasks: null, max_chats: null, schedule_exempt: null },
      effective: { max_tasks: 0, max_chats: 0, schedule_exempt: false },
    },
  })
  chatSessionApi.saveQuickButtons = async (_projectId, buttons) => ({ buttons })
  useChatListStore.setState({ quickButtons: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ProjectSettingsPanel project={project} onClose={() => {}} />
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })

    const assistantNav = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '对话助手')
    assert.ok(assistantNav)
    await act(async () => assistantNav.click())

    assert.equal(container.querySelector('[role="tablist"]'), null)
    assert.ok([...container.querySelectorAll('label')]
      .some((label) => label.textContent?.includes('全局提示词')))

    const quickButtonsNav = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '快捷按钮')
    assert.ok(quickButtonsNav)
    await act(async () => quickButtonsNav.click())

    const buttonList = container.querySelector('[data-testid="quick-button-list"]')
    assert.ok(buttonList)
    const draggableButtons = [...buttonList.querySelectorAll<HTMLButtonElement>('button[draggable="true"]')]
    assert.deepEqual(draggableButtons.map((button) => button.textContent?.trim()), ['解释', '写测试'])

    await act(async () => {
      draggableButtons[1].dispatchEvent(new Event('dragstart', { bubbles: true }))
      draggableButtons[0].dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
      draggableButtons[0].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    })

    assert.deepEqual(
      [...buttonList.querySelectorAll<HTMLButtonElement>('button[draggable="true"]')]
        .map((button) => button.textContent?.trim()),
      ['写测试', '解释'],
    )

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '保存')
    assert.ok(save)
    await act(async () => save.click())

    assert.deepEqual(
      useChatListStore.getState().quickButtons.map((button) => button.label),
      ['写测试', '解释'],
    )

    const addTab = [...buttonList.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '添加快捷按钮')
    assert.ok(addTab)
    await act(async () => addTab.click())
    assert.equal(buttonList.querySelectorAll('button[draggable="true"]').length, 3)
    assert.equal(buttonList.querySelector('[aria-current="true"]')?.textContent?.trim(), '新快捷按钮')
  } finally {
    projectApi.settings = originalSettings
    chatSessionApi.saveQuickButtons = originalSaveQuickButtons
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
