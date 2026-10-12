import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DesktopProjectDrop from '../src/components/DesktopProjectDrop'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { projectApi, type Project } from '../src/api/client'
const project: Project = { id: 'demo', name: 'Demo', path: '/demo', steps: {}, workflows: [] }
function drop(directory = true, path = '/demo') {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: directory }), getAsFile: () => ({ name: path }) }] } })
  document.body.dispatchEvent(event)
  return event
}
test('folder drop creates or selects projects, preserves file attachments, guards drafts and recovers from failure', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  useLocaleStore.getState().setLocale('zh-CN')
  const oldInit = projectApi.init
  const calls: string[] = []
  const selected: Project[] = []
  Object.assign(window, { workstepDesktop: { projects: {
    pathForFile: (file: File) => file.name,
    resolveDirectory: async (path: string) => path === '/alias' ? '/demo' : path,
  } } })
  useProjectStore.setState({ projects: [], activeProject: null, canvasDirty: false })
  projectApi.init = async path => { calls.push(path); if (path === '/bad') throw new Error('无法打开'); return project }
  const cancel = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === '取消')!.click()
  try {
    await act(async () => root.render(<I18nProvider><DesktopProjectDrop onSelectProject={p => selected.push(p)} /></I18nProvider>))
    const protectedDrag = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(protectedDrag, 'dataTransfer', { value: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => null }] } })
    document.body.dispatchEvent(protectedDrag)
    assert.equal(protectedDrag.defaultPrevented, true, 'protected dragover must allow the subsequent drop')
    let attachments = 0
    document.body.addEventListener('drop', event => { attachments++; event.stopPropagation() })
    assert.equal(drop(false).defaultPrevented, false)
    assert.equal(attachments, 1)
    await act(async () => { assert.equal(drop().defaultPrevented, true); drop() })
    assert.deepEqual(calls, ['/demo'])
    assert.equal(selected.length, 1)
    assert.equal(attachments, 1, 'folder drop is captured before attachment handlers')
    assert.equal(useProjectStore.getState().activeProject?.id, 'demo')
    await act(async () => { drop(true, '/alias') })
    assert.deepEqual(calls, ['/demo'])
    assert.equal(selected.length, 2)
    assert.equal(useProjectStore.getState().projects.length, 1)
    useProjectStore.setState({ canvasDirty: true })
    await act(async () => { drop(true, '/new') })
    assert.ok(container.querySelector('[role="dialog"]'))
    await act(async () => cancel())
    assert.equal(useProjectStore.getState().canvasDirty, true)
    assert.deepEqual(calls, ['/demo'])
    await act(async () => { drop(true, '/new') })
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === '确认')!.click())
    assert.deepEqual(calls, ['/demo', '/new'])
    assert.equal(useProjectStore.getState().canvasDirty, false)
    await act(async () => { drop(true, '/bad') })
    assert.match(container.textContent ?? '', /无法打开/)
    await act(async () => cancel())
    await act(async () => { drop() })
    assert.equal(selected.length, 4)
    delete (window as unknown as { workstepDesktop?: unknown }).workstepDesktop
    assert.equal(drop().defaultPrevented, false)
  } finally {
    projectApi.init = oldInit
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
