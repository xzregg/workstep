import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import NodeConfigPanel from '../src/components/NodeConfigPanel'
import ReviewOverridesEditor from '../src/components/ReviewOverridesEditor'
import ScheduleRuleEditor from '../src/components/ScheduleRuleEditor'
import { emptyReview, type StepNodeData } from '../src/components/flowCanvasData'
import { reviewOverridesForSubmit, reviewOverridesValid } from '../src/utils/numericConfigValidation'
import type { ScheduleRule } from '../src/api/client'

const noop = () => {}

async function setup() {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ models: [], buttons: [] })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const set = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const cleanup = async () => {
    await act(async () => root.unmount()); container.remove()
    globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
  return { root, container, set, cleanup }
}

test('step review retries and return rounds allow clearing and validate before stashing', async () => {
  const app = await setup()
  let node: StepNodeData = { nodeId: 1, key: 'write', label: '撰写', engine: '', model: '', color: '#2678dd', prompt: '', config: {}, inputs: [], outputs: [], maxReturnRounds: 12, review: { ...emptyReview(), mode: 'auto', maxRetries: 0 } }
  const saved: StepNodeData[] = []
  let error = ''
  const render = () => act(async () => app.root.render(<I18nProvider><NodeConfigPanel node={node} unavailableKeys={[]} engines={[]} enginesLoading={false} enginesError="" defaultExecutionEngine="" onValidationChange={value => { error = value }} onDraftChange={noop} onDirtyChange={noop} onSave={value => saved.push(value)} onRequestDelete={noop} onClose={noop} /></I18nProvider>))
  try {
    await render()
    const numbers = app.container.querySelectorAll<HTMLInputElement>('input[type="number"]')
    const rounds = numbers[0], retries = numbers[1]
    const save = [...app.container.querySelectorAll('button')].find(button => button.textContent === '暂存')!
    for (const [input, valid, invalid] of [[retries, '0', '-1'], [rounds, '20', '21']] as const) {
      await app.set(input, '')
      assert.equal(input.value, '')
      assert.equal(save.disabled, true)
      assert.ok(error)
      await act(async () => app.container.querySelector<HTMLInputElement>('.node-execution-settings-toggle input')!.click())
      assert.equal(saved.length, 0, 'auto-start changes cannot submit an invalid numeric draft')
      await render()
      assert.equal(input.value, '', 'ordinary renders preserve the empty draft')
      await app.set(input, invalid)
      assert.equal(input.value, invalid, 'editing does not clamp values')
      assert.equal(save.disabled, true)
      await app.set(input, '1.5')
      assert.equal(save.disabled, true)
      await app.set(input, valid)
      assert.equal(save.disabled, false)
    }
    await app.set(rounds, '12'); await app.set(rounds, '1'); await app.set(rounds, '')
    assert.equal(rounds.value, '')
    await app.set(rounds, '3'); await app.set(retries, '12')
    await act(async () => save.click())
    assert.equal(saved.length, 1)
    assert.equal(saved[0].review?.maxRetries, 12, 'workflow retries retain their unbounded nonnegative semantics')
    assert.equal(saved[0].maxReturnRounds, 3)
    node = saved[0]
    await render()
    assert.equal(rounds.value, '3')
    assert.equal(retries.value, '12')
  } finally { await app.cleanup() }
})

test('task review overrides keep an empty draft and do not clamp while typing', async () => {
  const app = await setup()
  function Harness() {
    const [value, setValue] = useState({ write: { mode: 'auto' as const, auto: true, prompt: '', maxRetries: 2 } })
    return <ReviewOverridesEditor value={value} onChange={setValue} lanes={[{ key: 'write', label: '撰写' }]} />
  }
  try {
    await act(async () => app.root.render(<I18nProvider><Harness /></I18nProvider>))
    const input = app.container.querySelector<HTMLInputElement>('input[type="number"]')!
    for (const value of ['', '6', '0', '1.5', '5', '', '3']) {
      await app.set(input, value)
      assert.equal(input.value, value)
      assert.equal(input.getAttribute('aria-invalid') === 'true', !['5', '3'].includes(value))
    }
  } finally { await app.cleanup() }
})

for (const rule of [{ kind: 'minutes', every: 10 }, { kind: 'interval', every: 12, unit: 'hours', weekdays: [1] }, { kind: 'monthly', monthdays: [12], time: '09:00' }] as ScheduleRule[]) {
  test(`schedule ${rule.kind} numbers can be deleted and replaced`, async () => {
    const app = await setup()
    function Harness() {
      const [value, setValue] = useState(rule)
      return <ScheduleRuleEditor value={value} onChange={setValue} />
    }
    try {
      await act(async () => app.root.render(<I18nProvider><Harness /></I18nProvider>))
      const input = app.container.querySelector<HTMLInputElement>('input[type="number"]')!
      for (const value of ['0', '1.5', rule.kind === 'monthly' ? '32' : rule.kind === 'interval' ? '25' : '10081']) {
        await app.set(input, value)
        assert.equal(input.value, value)
        assert.equal(input.getAttribute('aria-invalid'), 'true')
      }
      for (const value of ['1', '', '2', '', '12']) {
        await app.set(input, value)
        assert.equal(input.value, value)
      }
    } finally { await app.cleanup() }
  })
}

for (const mode of ['manual', 'skip'] as const) {
  test(`clearing step retries then selecting ${mode} allows saving a finite count`, async () => {
    const app = await setup()
    const node: StepNodeData = { nodeId: 1, key: 'write', label: '撰写', engine: '', model: '', color: '#2678dd', prompt: '', config: {}, inputs: [], outputs: [], maxReturnRounds: 3, review: { ...emptyReview(), mode: 'auto', maxRetries: 4 } }
    const saved: StepNodeData[] = []
    let error = ''
    try {
      await act(async () => app.root.render(<I18nProvider><NodeConfigPanel node={node} unavailableKeys={[]} engines={[]} enginesLoading={false} enginesError="" defaultExecutionEngine="" onValidationChange={value => { error = value }} onDraftChange={noop} onDirtyChange={noop} onSave={value => saved.push(value)} onRequestDelete={noop} onClose={noop} /></I18nProvider>))
      await app.set(app.container.querySelector<HTMLInputElement>('[aria-label="重试"]')!, '')
      const button = (label: string) => [...app.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!
      assert.equal(button('暂存').disabled, true)
      await act(async () => button(mode === 'manual' ? '人工审核' : '跳过审核').click())
      assert.equal(app.container.querySelector('[aria-label="重试"]') === null, true)
      assert.equal(button('暂存').disabled, false)
      assert.equal(error, '')
      await act(async () => button('暂存').click())
      assert.equal(saved.length, 1)
      assert.equal(saved[0].review?.mode, mode)
      assert.equal(saved[0].review?.maxRetries, 4)
      assert.equal(JSON.stringify(saved[0]).includes('null'), false)
    } finally { await app.cleanup() }
  })
}


test('inactive review counts serialize safely without losing the active editing draft', () => {
  const lanes = [{ key: 'write' }, { key: 'check' }]
  for (const maxRetries of [NaN, Infinity, 0, 6, 1.5]) {
    const draft = { write: { mode: 'auto', maxRetries, prompt: '保留正文' }, check: { mode: 'auto', maxRetries: 2, prompt: '' } }
    assert.equal(reviewOverridesValid(draft, lanes, 'write'), false)
    assert.equal(reviewOverridesValid(draft, lanes, 'check'), true)
    const submitted = reviewOverridesForSubmit(draft, { write: { mode: 'auto', maxRetries: 4 } })
    assert.equal(submitted.write.maxRetries, 4)
    assert.equal(submitted.write.prompt, '保留正文')
    assert.equal(submitted.check.maxRetries, 2)
    assert.equal(Object.is(draft.write.maxRetries, maxRetries), true)
    assert.equal(reviewOverridesValid(draft, lanes, 'write'), false)
    assert.equal(reviewOverridesForSubmit(draft).write.maxRetries, 1)
    assert.equal(reviewOverridesForSubmit(draft, { write: { mode: 'auto', maxRetries: NaN } }).write.maxRetries, 1)
    for (const mode of ['manual', 'skip']) {
      assert.equal(reviewOverridesValid({ write: { mode, maxRetries } }, lanes), true)
    }
  }
})
