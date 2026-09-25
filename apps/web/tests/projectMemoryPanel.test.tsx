import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fsApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import ProjectMemoryPanel from '../src/components/ProjectMemoryPanel'

test('project memory panel reads the selected project and saves its content', async () => {
  const { window } = installDomEnvironment()
  const originalRead = fsApi.readMemory
  const originalSave = fsApi.saveMemory
  const calls: unknown[][] = []
  fsApi.readMemory = async (projectId) => { calls.push(['read', projectId]); return { path: '.workstep/MEMORY.md', content: 'Existing memory' } }
  fsApi.saveMemory = async (projectId, content) => { calls.push(['save', projectId, content]); return { path: '.workstep/MEMORY.md', saved: true } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let closed = 0
  try {
    await act(async () => root.render(<I18nProvider><ProjectMemoryPanel
      projectId="project" onClose={() => { closed++ }}
    /></I18nProvider>))
    assert.deepEqual(calls[0], ['read', 'project'])
    assert.match(container.textContent || '', /Existing memory/)
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Save|保存/.test(button.textContent || '') && !button.disabled)!
    await act(async () => save.click())
    assert.deepEqual(calls[1], ['save', 'project', 'Existing memory'])
    assert.equal(closed, 1)
  } finally {
    await act(async () => root.unmount())
    fsApi.readMemory = originalRead
    fsApi.saveMemory = originalSave
    container.remove()
    await window.happyDOM.close()
  }
})

test('project memory panel asks before discarding edits', async () => {
  const { window } = installDomEnvironment()
  const originalRead = fsApi.readMemory
  fsApi.readMemory = async () => ({ path: '.workstep/MEMORY.md', content: 'Original' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let closed = 0
  try {
    await act(async () => root.render(<I18nProvider><ProjectMemoryPanel
      projectId="project" onClose={() => { closed++ }}
    /></I18nProvider>))
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!
    assert.ok(editor)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Changed')
      editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const cancel = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Cancel|取消/.test(button.textContent || '') && !button.disabled)!
    await act(async () => cancel.click())
    assert.equal(closed, 0)
    const discard = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Discard|丢弃/.test(button.textContent || '') && !button.disabled)!
    await act(async () => discard.click())
    assert.equal(closed, 1)
  } finally {
    await act(async () => root.unmount())
    fsApi.readMemory = originalRead
    container.remove()
    await window.happyDOM.close()
  }
})
