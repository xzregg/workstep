import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import WorkflowNameEditor from '../src/components/WorkflowNameEditor'
import { useProjectStore } from '../src/stores/projectStore'
import { I18nProvider } from '../src/i18n'

test('workflow panel name supports double-click rename, validation, retry and cancellation', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalRename = useProjectStore.getState().renameWorkflow
  const calls: string[][] = []
  useProjectStore.setState({ renameWorkflow: async (id, projectId, name) => {
    calls.push([id, projectId, name])
    if (calls.length === 1) throw new Error('retry rename')
    return { id, name } as any
  } })
  const render = async (canEdit = true, workflowId = 'flow-1') => act(async () => root.render(
    <I18nProvider><WorkflowNameEditor key={workflowId} projectId="project-1" workflowId={workflowId} name="原流程" canEdit={canEdit} /></I18nProvider>,
  ))
  const doubleClick = async () => act(async () => {
    container.querySelector('[title="原流程"]')!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  })
  const change = async (name: string) => act(async () => {
    const input = container.querySelector('input')!
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, name)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const key = async (value: string) => act(async () => {
    container.querySelector('input')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }))
  })
  try {
    await render()
    const title = container.querySelector('[title="原流程"]')!
    await act(async () => { title.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    assert.equal(container.querySelector('input'), null)
    await doubleClick()
    assert.equal(document.activeElement, container.querySelector('input'))
    await change('')
    await key('Enter')
    assert.equal(calls.length, 0)
    assert.equal(container.querySelector('input'), null)
    await doubleClick()
    await change('含 空格')
    await key('Enter')
    assert.equal(calls.length, 0)
    assert.ok(container.querySelector('[role="alert"]'))
    await change('新流程')
    await key('Enter')
    assert.match(container.textContent!, /retry rename/)
    assert.ok(container.querySelector('input'))
    await key('Enter')
    assert.deepEqual(calls, [['flow-1', 'project-1', '新流程'], ['flow-1', 'project-1', '新流程']])
    assert.equal(container.querySelector('input'), null)
    await doubleClick()
    await change('取消修改')
    await key('Escape')
    assert.equal(calls.length, 2)
    assert.equal(container.querySelector('input'), null)
    await doubleClick()
    await change('失焦保存')
    await act(async () => { (container.querySelector('input') as HTMLInputElement).blur() })
    assert.deepEqual(calls.at(-1), ['flow-1', 'project-1', '失焦保存'])
    await doubleClick()
    await render(true, 'flow-2')
    assert.equal(container.querySelector('input'), null)
    await render(false, 'flow-2')
    await doubleClick()
    assert.equal(container.querySelector('input'), null)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState({ renameWorkflow: originalRename })
    container.remove()
    await window.happyDOM.close()
  }
})
