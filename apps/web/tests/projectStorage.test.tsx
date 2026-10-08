import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { projectApi } from '../src/api/project'
import ProjectStorageSettings from '../src/components/ProjectStorageSettings'
import ProjectStorageField from '../src/components/ProjectStorageField'
import ProjectConnectionDialog from '../src/components/ProjectConnectionDialog'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { useManagedModeStore } from '../src/stores/managedModeStore'
import { useProjectStore } from '../src/stores/projectStore'

test('project storage change requires confirmation and preserves selection after failure', async () => {
  installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalGet = projectApi.storage
  const originalSet = projectApi.setStorage
  let calls = 0
  projectApi.storage = async () => ({ follow_project: true, data_path: '/demo/.workstep' })
  projectApi.setStorage = async (_id, follow) => {
    calls++
    if (calls === 1) throw new Error('项目有运行中的任务或会话，不能迁移')
    return { follow_project: follow, data_path: '/home/demo/.workstep/projects/id' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProjectStorageSettings projectId="id" /></I18nProvider>))
    assert.equal(container.querySelector<HTMLInputElement>('input')?.checked, true)
    await act(async () => container.querySelector<HTMLInputElement>('input')!.click())
    assert.equal(calls, 0)
    assert.match(document.body.textContent ?? '', /保留 .workstep\/project.json/)
    const confirm = () => [...document.querySelectorAll('button')].find(button => button.textContent === '确认')!
    await act(async () => confirm().click())
    assert.equal(calls, 1)
    assert.match(document.body.textContent ?? '', /运行中的任务/)
    assert.equal(container.querySelector<HTMLInputElement>('input')?.checked, true)
    await act(async () => confirm().click())
    assert.equal(calls, 2)
    assert.equal(container.querySelector<HTMLInputElement>('input')?.checked, false)
    assert.match(container.textContent ?? '', /projects\/id/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    projectApi.storage = originalGet
    projectApi.setStorage = originalSet
  }
})

test('shared storage field explains identity and computer migration', async () => {
  installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProjectStorageField value={false} onChange={() => {}} /></I18nProvider>))
    assert.match(container.textContent ?? '', /跨电脑迁移/)
    assert.match(container.textContent ?? '', /原数据不会被删除/)
  } finally { await act(async () => root.unmount()); container.remove() }
})


test('project creation defaults to following project and sends explicit external selection', async () => {
  installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useManagedModeStore.setState({ managed: false, loading: false })
  useUserSettingsStore.setState({ loaded: true, loading: false, defaultProjectDirectory: '/demo' })
  const originalFetch = globalThis.fetch
  const originalInit = useProjectStore.getState().initProject
  const originalLoad = useUserSettingsStore.getState().load
  const selections: boolean[] = []
  useUserSettingsStore.setState({ load: async () => {} })
  useProjectStore.setState({ initProject: async (_path, _name, follow) => {
    selections.push(follow ?? true)
    return { id: 'new', name: 'demo', path: '/demo', steps: [], workflows: [] }
  } })
  globalThis.fetch = async () => Response.json({ path: '/demo', parent: '/', entries: [{ name: 'project', path: '/demo/project', type: 'directory' }] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProjectConnectionDialog open onClose={() => {}} onConnected={() => {}} /></I18nProvider>))
    const confirm = () => [...container.querySelectorAll('button')].find(button => button.textContent === '确定')!
    assert.equal(confirm().disabled, true)
    assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true)
    const directory = container.querySelector('[role="option"]')!
    await act(async () => directory.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    assert.equal(confirm().disabled, false)
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => confirm().click())
    assert.deepEqual(selections, [false])
    assert.equal(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true)
  } finally {
    await act(async () => root.unmount()); container.remove()
    globalThis.fetch = originalFetch
    useProjectStore.setState({ initProject: originalInit })
    useUserSettingsStore.setState({ load: originalLoad })
  }
})
