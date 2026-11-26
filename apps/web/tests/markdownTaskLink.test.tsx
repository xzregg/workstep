import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import MarkdownContent from '../src/components/MarkdownContent'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { taskApi, type Project } from '../src/api/client'

test('created-task links open the real task in-app, including historical replies', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.get
  const originalState = useProjectStore.getState()
  const project = { id: 'p1', name: '项目演示' } as Project
  let refreshes = 0
  useProjectStore.setState({ projects: [project], activeProject: project, fetchProjects: async () => {
    refreshes++
    useProjectStore.setState({ projects: [{ ...project, workflows: [{ id: 'w1', name: '新流程', is_default: false }] }] })
  } })
  let calls = 0
  taskApi.get = async (taskId, projectId) => {
    calls++
    assert.equal(taskId, 't1'); assert.equal(projectId, 'p1')
    return { id: 't1', workflow_id: 'w1' } as Awaited<ReturnType<typeof taskApi.get>>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let location = ''
  function Location() { const route = useLocation(); location = route.pathname + route.search; return null }
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/chat?project=demo&session=s1']}>
      <Location /><MarkdownContent projectId="p1" content="[打开任务详情](workstep-task://open?project_id=p1&task_id=t1)" />
    </MemoryRouter></I18nProvider>))
    const button = container.querySelector('button.markdown-task-link') as HTMLButtonElement
    assert.ok(button)
    assert.equal(calls, 0)
    await act(async () => button.click())
    assert.equal(calls, 1)
    assert.equal(refreshes, 1) // Newly created workflows must reach the route cache.
    const url = new URL(location, 'http://localhost')
    assert.equal(url.pathname, '/tasks')
    assert.equal(url.searchParams.get('project'), '项目演示')
    assert.equal(url.searchParams.get('workflow'), 'w1')
    assert.equal(url.searchParams.get('task'), 't1')
    assert.equal(url.searchParams.has('session'), false)
  } finally {
    taskApi.get = original
    useProjectStore.setState(originalState)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('digital hub task receipts open the target project task through its scoped API', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.get, projects = useProjectStore.getState()
  const home = { id: 'hub', name: '默认工作区', is_default_workspace: true } as Project
  const target = { id: 'target', name: '开发项目', workflows: [{ id: 'flow', name: '开发流程' }] } as Project
  useProjectStore.setState({ projects: [home, target], activeProject: home })
  let calls=0,location=''
  taskApi.get = async (id, pid) => { calls++; assert.equal(pid,'target'); return {id,workflow_id:'flow'} as any }
  const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  function Location(){const value=useLocation();location=value.pathname+value.search;return null}
  try {
    await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><Location/>
      <MarkdownContent projectId="hub" content="[打开任务详情](workstep-task://open?project_id=target&task_id=work)"/>
    </I18nProvider></MemoryRouter>))
    const button=host.querySelector<HTMLButtonElement>('.markdown-task-link')
    assert.equal(Boolean(button),true)
    await act(async()=>button!.click())
    assert.equal(calls,1)
    assert.equal(new URL(location,'http://test').searchParams.get('task'),'work')
  } finally {
    await act(async()=>root.unmount()); taskApi.get=original;useProjectStore.setState(projects);await window.happyDOM.close()
  }
})

test('task links reject cross-project targets and report deleted tasks without navigation', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.get
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let calls = 0
  taskApi.get = async () => { calls++; throw new Error('任务已删除') }
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter>
      <MarkdownContent projectId="p1" content="[跨项目](workstep-task://open?project_id=other&task_id=t1)" />
    </MemoryRouter></I18nProvider>))
    assert.ok(container.querySelector('.markdown-task-link') === null)
    assert.equal(calls, 0)
    await act(async () => root.render(<I18nProvider><MemoryRouter>
      <MarkdownContent projectId="p1" content="[打开任务详情](workstep-task://open?project_id=p1&task_id=missing)" />
    </MemoryRouter></I18nProvider>))
    await act(async () => (container.querySelector('.markdown-task-link') as HTMLButtonElement).click())
    assert.equal(calls, 1)
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /任务已删除/)
  } finally {
    taskApi.get = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('streaming task links stay disabled and completion preserves the existing text DOM', async () => {
  const { window }=installDomEnvironment()
  const host=document.body.appendChild(document.createElement('div'))
  const root=createRoot(host)
  const render=(streaming:boolean)=>act(async()=>root.render(<I18nProvider><MemoryRouter>
    <MarkdownContent projectId="p1" content="稳定正文 [打开任务详情](workstep-task://open?project_id=p1&task_id=t1)" streaming={streaming}/>
  </MemoryRouter></I18nProvider>))
  try {
    await render(true)
    const paragraph=host.querySelector('p')
    const button=host.querySelector('.markdown-task-link') as HTMLButtonElement
    assert.ok(button.disabled)
    await render(false)
    assert.ok(host.querySelector('p') === paragraph)
    assert.ok(host.querySelector('.markdown-task-link') === button)
    assert.equal(button.disabled,false)
  } finally {
    await act(async()=>root.unmount())
    await window.happyDOM.close()
  }
})
