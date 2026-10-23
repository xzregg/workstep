import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
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
    assert.equal(container.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    assert.equal(calls, 0)
    assert.match(document.body.textContent ?? '', /保留 .workstep\/project.json/)
    const confirm = () => [...document.querySelectorAll('button')].find(button => button.textContent === '确认')!
    await act(async () => confirm().click())
    assert.equal(calls, 1)
    assert.match(document.body.textContent ?? '', /运行中的任务/)
    assert.equal(container.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
    await act(async () => confirm().click())
    assert.equal(calls, 2)
    assert.equal(container.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'false')
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

test('storage switch label keeps its flex alignment inside modal forms', async () => {
  installDomEnvironment()
  const style = document.head.appendChild(document.createElement('style'))
  style.textContent = readFileSync(new URL('../src/components/ProjectStorageField.css', import.meta.url), 'utf8')
    + '\n' + readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const container = document.body.appendChild(document.createElement('div'))
  container.className = 'modal-body'
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProjectStorageField value onChange={() => {}} /></I18nProvider>))
    const label = container.querySelector('label')!
    const computed = getComputedStyle(label)
    assert.equal(computed.display, 'flex')
    assert.equal(computed.alignItems, 'center')
    assert.equal(computed.gap, '8px')
    assert.equal(computed.marginBottom, '0px')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    style.remove()
  }
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
    assert.equal(container.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
    const directory = container.querySelector('[role="option"]')!
    await act(async () => directory.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    assert.equal(confirm().disabled, false)
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    await act(async () => confirm().click())
    assert.deepEqual(selections, [false])
    assert.equal(container.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
  } finally {
    await act(async () => root.unmount()); container.remove()
    globalThis.fetch = originalFetch
    useProjectStore.setState({ initProject: originalInit })
    useUserSettingsStore.setState({ load: originalLoad })
  }
})


for (const owner of [true, false]) {
test(`gateway project picker loads permission before browsing on a phone: owner=${owner}`, async () => {
  const { window } = installDomEnvironment()
  window.location.href = 'http://192.168.52.156:8700/workspace/device-one/'
  window.innerWidth = 390
  useLocaleStore.setState({ locale: 'zh-CN' })
  const managedState = useManagedModeStore.getState()
  const settingsState = useUserSettingsStore.getState()
  const originalInit = useProjectStore.getState().initProject
  const originalFetch = globalThis.fetch
  useManagedModeStore.setState({ managed: null, loading: false, canManageRemoteProjects: false })
  useUserSettingsStore.setState({ loaded: true, defaultProjectDirectory: '/demo', load: async () => {} })
  const calls: string[] = []
  let resolvePermission!: (response: Response) => void
  const permission = new Promise<Response>(resolve => { resolvePermission = resolve })
  const added: string[] = []
  useProjectStore.setState({ initProject: async path => {
    added.push(path)
    return { id: 'new', name: 'demo', path, steps: [], workflows: [] }
  } })
  globalThis.fetch = async input => {
    const path = String(input)
    calls.push(path)
    if (path.endsWith('/managed/mode')) return permission
    return Response.json({ path: '/demo', parent: '/', entries: [{ name: 'project', path: '/demo/project', type: 'directory' }] })
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    const render = () => root.render(<I18nProvider><ProjectConnectionDialog open onClose={() => {}} onConnected={() => {}} /></I18nProvider>)
    await act(async () => render())
    assert.deepEqual(calls, ['/workspace/device-one/api/managed/mode'])
    assert.doesNotMatch(container.textContent ?? '', /仅在电脑本机可用/)
    assert.equal(container.querySelector('[role="option"]'), null)
    await act(async () => resolvePermission(Response.json({ managed: true, can_manage_remote_projects: owner })))
    if (!owner) {
      assert.match(container.textContent ?? '', /仅在电脑本机可用/)
      assert.equal(container.querySelector('[role="option"]'), null)
      assert.deepEqual(added, [])
      assert.equal(calls.length, 1)
      return
    }
    const directory = container.querySelector('[role="option"]')!
    assert.ok(directory)
    await act(async () => directory.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === '确定')!
    await act(async () => confirm.click())
    assert.deepEqual(added, ['/demo/project'])
    await act(async () => render())
    assert.equal(calls.filter(path => path.endsWith('/managed/mode')).length, 1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
    useManagedModeStore.setState(managedState, true)
    useUserSettingsStore.setState(settingsState, true)
    useProjectStore.setState({ initProject: originalInit })
    await window.happyDOM.close()
  }
})
}

for (const owner of [true,false]) {
 test(`gateway project picker permits device owner only: ${owner}`,async()=>{
  const {window}=installDomEnvironment();window.location.href='http://192.168.52.156:8700/workspace/device-one/'
  useLocaleStore.setState({locale:'zh-CN'})
  useManagedModeStore.setState({managed:true,loading:false,canManageRemoteProjects:owner})
  const originalFetch=globalThis.fetch;const originalInit=useProjectStore.getState().initProject;const originalLoad=useUserSettingsStore.getState().load
  useUserSettingsStore.setState({loaded:true,defaultProjectDirectory:'/demo',load:async()=>{}})
  let added=0
  useProjectStore.setState({initProject:async()=>{added++;return {id:'new',name:'demo',path:'/demo',steps:[],workflows:[]}}})
  globalThis.fetch=async()=>Response.json({path:'/demo',parent:'/',entries:[{name:'project',path:'/demo/project',type:'directory'}]})
  const container=document.body.appendChild(document.createElement('div'));const root=createRoot(container)
  try {
   await act(async()=>root.render(<I18nProvider><ProjectConnectionDialog open onClose={()=>{}} onConnected={()=>{}}/></I18nProvider>))
   if(owner) {
    const directory=container.querySelector('[role=option]')!
    assert.ok(directory)
    await act(async()=>directory.dispatchEvent(new MouseEvent('click',{bubbles:true})))
    const confirm=[...container.querySelectorAll('button')].find(button=>button.textContent==='确定')!
    await act(async()=>confirm.click())
    assert.equal(added,1)
   } else {
    assert.equal(container.querySelector('[role=listbox]'),null)
    assert.equal(added,0)
   }
  } finally {
   await act(async()=>root.unmount());container.remove();globalThis.fetch=originalFetch
   useProjectStore.setState({initProject:originalInit});useUserSettingsStore.setState({load:originalLoad})
   useManagedModeStore.setState({managed:null,canManageRemoteProjects:false});await window.happyDOM.close()
  }
 })
}
