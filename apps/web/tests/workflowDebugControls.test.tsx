import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { StartDebug } from '../src/components/WorkflowDebugControls'
import type { DebugWorkflow } from '../src/api/workflowDebug'

const draft: DebugWorkflow = {
  nodes: [{ id: 1, type: 'a', title: 'A', outputs: [{ name: 'plan', type: 'Markdown' }] },
    { id: 2, type: 'b', title: 'B' }, { id: 3, type: 'c', title: 'C' }],
  connections: [{ from: 1, to: 2, fromPort: 0 }, { from: 3, to: 2, kind: 'dashed' }],
}

test('starting at B accepts the contents of the connected A output without a path input', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const submissions: unknown[] = []
  try {
    await act(async () => root.render(<I18nProvider><StartDebug workflow={draft} busy={false}
      onStart={values => submissions.push(values)} /></I18nProvider>))
    const change = async (id: string, value: string) => {
      const field = host.querySelector<HTMLInputElement>(id)!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
        setter?.call(field, value)
        field.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }
    await change('#debug-title', 'Preview')
    assert.ok(host.querySelector('textarea#debug-description.markdown-editor-input'))
    await change('#debug-description', '## Goal\n\n- Verify output')
    assert.ok(host.querySelector('fieldset.radio-card-group[data-variant="compact"]'))
    const tile = (value: string) => host.querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`)!
    assert.deepEqual([...host.querySelectorAll('input[type=radio]')].map(option => option.getAttribute('value')), ['a', 'b', 'c'])
    assert.ok(tile('a').checked)
    await act(async () => tile('b').click())
    assert.ok(tile('b').checked)
    assert.equal(tile('a').checked, false)
    const submit = host.querySelector<HTMLButtonElement>('[type=submit]')!
    assert.equal(submit.disabled, true)
    assert.equal(host.querySelectorAll('textarea[id^=debug-sample]').length, 1)
    await change('#debug-sample-a\\:0', '# A sample')
    const sampleEditor = host.querySelector('.workflow-debug-samples .markdown-editor-root')!
    const preview = sampleEditor.querySelector<HTMLButtonElement>('.markdown-editor-action[data-active]')!
    assert.ok(sampleEditor.querySelector('input[type=file]') === null)
    assert.equal(sampleEditor.querySelector('textarea')?.placeholder, '')
    await act(async () => preview.click())
    assert.equal(sampleEditor.querySelector('.markdown-editor-preview h1')?.textContent, 'A sample')
    assert.equal(submissions.length, 0)
    await act(async () => preview.click())
    await act(async () => tile('c').click())
    assert.ok(host.querySelector('textarea[id^=debug-sample]') === null)
    await act(async () => tile('b').click())
    assert.equal(host.querySelector<HTMLTextAreaElement>('textarea[id^=debug-sample]')?.value, '# A sample')
    assert.equal(submit.disabled, false)
    await act(async () => { host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
    assert.deepEqual(submissions, [{ workflow: draft, title: 'Preview', description: '## Goal\n\n- Verify output', step_key: 'b',
      samples: [{ step_key: 'a', port: 0, content: '# A sample' }] }])
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await window.happyDOM.close()
  }
})
