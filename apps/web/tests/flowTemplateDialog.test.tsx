import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { invalidateTemplates, templateApi } from '../src/api/client'
import FlowTemplateDialog from '../src/components/FlowTemplateDialog'

test('template picker confirms before loading the selected template', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalList = templateApi.list
  const originalGet = templateApi.get
  let loaded = 0
  let applied: unknown = null
  templateApi.list = async () => ({ templates: [{ id: 'sample', name: 'Sample Flow', description: '', nodeCount: 1 }] })
  templateApi.get = async () => {
    loaded += 1
    return { id: 'sample', name: 'Sample Flow', description: '', nodeCount: 1,
      steps: { nodes: [{ id: 1, type: 'build' }], connections: [] } }
  }
  invalidateTemplates()
  try {
    await act(async () => root.render(<I18nProvider><FlowTemplateDialog open onClose={() => {}}
      getSteps={() => ({ nodes: [], connections: [] })}
      onApply={(steps) => { applied = steps }} onFeedback={() => {}}
    /></I18nProvider>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const choice = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Sample Flow'))
    assert.ok(choice)
    await act(async () => choice.click())
    assert.equal(loaded, 0)
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('应用模板') || button.textContent?.includes('Apply template'))
    assert.ok(confirm)
    await act(async () => confirm.click())
    assert.equal(loaded, 1)
    assert.deepEqual(applied, { nodes: [{ id: 1, type: 'build' }], connections: [] })
  } finally {
    templateApi.list = originalList
    templateApi.get = originalGet
    invalidateTemplates()
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('saving the current canvas as a template refreshes the catalog', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalList = templateApi.list
  const originalSave = templateApi.save
  let listed = 0
  let saved: Parameters<typeof templateApi.save>[0] | null = null
  const feedback: string[] = []
  templateApi.list = async () => { listed += 1; return { templates: [] } }
  templateApi.save = async (template) => {
    saved = template
    return { saved: true, id: template.id }
  }
  invalidateTemplates()
  try {
    await act(async () => root.render(<I18nProvider><FlowTemplateDialog open onClose={() => {}}
      getSteps={() => ({ nodes: [{ id: 7, type: 'build' }], connections: [] })}
      onApply={() => {}} onFeedback={(message) => feedback.push(message)}
    /></I18nProvider>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const saveAs = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('保存当前为流程模板') || button.textContent?.includes('Save current as flow template'))
    assert.ok(saveAs)
    await act(async () => saveAs.click())
    const name = container.querySelectorAll<HTMLInputElement>('input')[1]
    assert.ok(name)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    assert.ok(setter)
    await act(async () => { setter.call(name, 'Reusable Flow'); name.dispatchEvent(new window.Event('input', { bubbles: true })) })
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('保存模板') || button.textContent?.includes('Save template'))
    assert.ok(save)
    await act(async () => save.click())
    assert.equal(saved?.name, 'Reusable Flow')
    assert.equal(saved?.id, 'reusable-flow')
    assert.equal(listed, 2)
    assert.equal(feedback.length, 1)
  } finally {
    templateApi.list = originalList
    templateApi.save = originalSave
    invalidateTemplates()
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
