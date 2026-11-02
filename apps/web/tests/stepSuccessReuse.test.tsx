import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import NodeConfigPanel from '../src/components/NodeConfigPanel'
import { loadCanvasData, type StepNodeData } from '../src/components/flowCanvasData'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('reuse success defaults off and survives both workflow formats', () => {
  for (const raw of [
    { nodes: [{ id: 1, type: 'branch', reuseSuccess: true }], connections: [] },
    { steps: [{ key: 'branch', reuseSuccess: true }] },
  ]) assert.equal(loadCanvasData(raw).nodes[0].reuseSuccess, true)
  assert.equal(Boolean(loadCanvasData({ nodes: [{ id: 1, type: 'branch' }] }).nodes[0].reuseSuccess), false)
})

test('step execution settings save reuse success explicitly, with direct-trigger help', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, { window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }) })
  useLocaleStore.getState().setLocale('zh-CN')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const saved: StepNodeData[] = []
  const node = loadCanvasData({ nodes: [{ id: 1, type: 'branch', title: '分支名确定', outputs: [{ name: 'branch', type: 'md' }] }] }).nodes[0]
  const noop = () => {}
  try {
    await act(async () => root.render(<I18nProvider><NodeConfigPanel node={node}
      unavailableKeys={[]} engines={[]} enginesLoading={false} enginesError="" defaultExecutionEngine=""
      onValidationChange={noop} onDraftChange={noop} onDirtyChange={noop}
      onSave={(value) => saved.push(value)} onRequestDelete={noop} onClose={noop} /></I18nProvider>))
    const checkbox = container.querySelector<HTMLInputElement>('#step-reuse-success')
    assert.ok(checkbox)
    const keyRow = container.querySelector('#step-type')?.parentElement
    assert.ok(keyRow?.contains(checkbox), 'reuse success belongs in the step identifier row')
    assert.match(keyRow.textContent || '', /创建后自动开始/)
    assert.equal(container.querySelector('.node-execution-settings'), null)
    assert.equal(checkbox.checked, false)
    assert.match(container.textContent || '', /成功后复用/)
    assert.match(container.textContent || '', /返工/)
    await act(async () => checkbox.click())
    const save = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('暂存'))
    assert.ok(save)
    await act(async () => save.click())
    assert.equal(saved.at(-1)?.reuseSuccess, true)
    await act(async () => checkbox.click())
    await act(async () => save.click())
    assert.equal(saved.at(-1)?.reuseSuccess, false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
