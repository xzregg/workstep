import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import FlowStepApplyPanel from '../src/components/FlowStepApplyPanel'
import type { GenProposalCard } from '../src/stores/workflowGenStore'

const base = { nodes: [{ id: 1, type: 'write', title: '撰写' }, { id: 2, type: 'manual', title: '整理' }], connections: [] }
const card: GenProposalCard = { id: 'p1', title: '加入核查', summary: '归纳后核查', nodeCount: 2,
  steps: { nodes: [{ id: 1, type: 'write', title: '归纳' }, { id: 3, type: 'check', title: '核查' }], connections: [] },
  patch: { upsertNodes: [{ id: 1, type: 'write', title: '归纳' }, { id: 3, type: 'check', title: '核查' }], removeNodeIds: [2] },
  stepChanges: [{ id: 1, key: 'write', title: '归纳', change: 'updated' }, { id: 2, key: 'manual', title: '整理', change: 'removed' }, { id: 3, key: 'check', title: '核查', change: 'added' }],
}

test('inline choices preview immediately, re-preview selection and apply only selected steps', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  const previews: any[] = [], applied: any[] = []
  try {
    await act(async () => root.render(<I18nProvider><FlowStepApplyPanel cards={[card]} currentSteps={() => base}
      onPreview={steps => previews.push(steps)} onApply={steps => { applied.push(steps) }} /></I18nProvider>))
    assert.equal(applied.length, 0)
    assert.deepEqual(previews.at(-1).nodes.map((n: any) => n.title), ['归纳', '核查'])
    assert.equal(el.querySelectorAll('input[type=checkbox]').length, 3)
    await act(async () => (el.querySelectorAll('input')[1] as HTMLInputElement).click())
    assert.deepEqual(previews.at(-1).nodes.map((n: any) => n.title), ['归纳', '整理', '核查'])
    const apply = el.querySelector<HTMLButtonElement>('[data-apply-proposal]')!
    await act(async () => apply.click())
    assert.equal(applied.length, 1)
    assert.deepEqual(applied[0].nodes.map((n: any) => n.title), ['归纳', '整理', '核查'])
    assert.deepEqual(base.nodes.map(n => n.title), ['撰写', '整理'])
    await act(async () => root.unmount())
    assert.equal(previews.at(-1), null, 'closing removes the display-only preview')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('no selection disables apply; alternate whole proposals preview without applying', async () => {
  const { window } = installDomEnvironment(), el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  const previews: any[] = []
  const whole = { ...card, id: 'p2', title: '完整方案', patch: undefined, stepChanges: undefined }
  const cards = [card, whole]
  try {
    await act(async () => root.render(<I18nProvider><FlowStepApplyPanel cards={cards} currentSteps={() => base}
      onPreview={steps => previews.push(steps)} onApply={() => assert.fail('preview must not apply')} /></I18nProvider>))
    for (const checkbox of el.querySelectorAll('input')) await act(async () => checkbox.click())
    assert.equal(el.querySelector<HTMLButtonElement>('[data-apply-proposal]')!.disabled, true)
    assert.deepEqual(previews.at(-1), base)
    const alternative = [...el.querySelectorAll('button')].find(b => b.textContent === '预演此方案')!
    await act(async () => alternative.click())
    assert.deepEqual(previews.at(-1), whole.steps)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})


test('a new chat proposal reusing a card id starts with its own selection', async () => {
  const { window } = installDomEnvironment(), el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  const previews: any[] = []
  const render = (proposal: GenProposalCard) => <I18nProvider><FlowStepApplyPanel cards={[proposal]} currentSteps={() => base}
    onPreview={steps => previews.push(steps)} onApply={() => {}} /></I18nProvider>
  try {
    await act(async () => root.render(render(card)))
    await act(async () => (el.querySelector('input') as HTMLInputElement).click())
    assert.equal(el.querySelector<HTMLInputElement>('input')!.checked,false)
    const second = { ...card, title:'下一轮', steps:{...card.steps} }
    await act(async () => root.render(render(second)))
    assert.ok([...el.querySelectorAll('input')].every(input => input.checked))
    assert.equal(previews.at(-1).nodes[0].title,'归纳')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
