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

test('conversation assistant uses tabs and saved quick buttons take effect immediately', async () => {
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

    const tabList = container.querySelector('[role="tablist"]')
    assert.ok(tabList)
    assert.deepEqual(
      [...tabList.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim()),
      ['全局提示词', '解释', '写测试', '添加快捷按钮'],
    )

    const testsTab = [...tabList.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '写测试')
    assert.ok(testsTab)
    await act(async () => testsTab.click())

    const save = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '保存')
    assert.ok(save)
    await act(async () => save.click())

    assert.deepEqual(
      useChatListStore.getState().quickButtons.map((button) => button.label),
      ['解释', '写测试'],
    )

    const addTab = [...tabList.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '添加快捷按钮')
    assert.ok(addTab)
    await act(async () => addTab.click())
    assert.equal(tabList.querySelectorAll('[role="tab"]').length, 5)
    assert.equal(tabList.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(), '新快捷按钮')
  } finally {
    projectApi.settings = originalSettings
    chatSessionApi.saveQuickButtons = originalSaveQuickButtons
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
