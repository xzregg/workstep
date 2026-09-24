import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import QuickButtonEditor, { quickButtonFromDraft, quickButtonToDraft, type QuickButtonDraft } from '../src/components/QuickButtonEditor'
import WorkflowQuickButtonsSection from '../src/components/WorkflowQuickButtonsSection'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('shared shortcut editor exposes display title and HTML content', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const buttons: QuickButtonDraft[] = [{
    id: 'link', label: '开发地址', prompt: '', content: '<a href="http://localhost:5173">前端</a>',
    kind: 'display', immediateSend: false, actionId: '', scriptPath: '', cwdMode: 'task', requireConfirmation: true,
  }]
  try {
    await act(async () => root.render(<I18nProvider>
      <QuickButtonEditor projectId="project-1" buttons={buttons} onChange={() => {}} selectedId="link" onSelect={() => {}} onSave={() => {}} />
    </I18nProvider>))
    assert.equal(container.querySelector<HTMLTextAreaElement>('[data-testid="quick-button-display-content"]')?.value, buttons[0].content)
    assert.equal(container.querySelector('a')?.textContent, '前端')
    assert.match(container.textContent || '', /开发地址/)
    assert.equal(quickButtonFromDraft(buttons[0]).content, buttons[0].content)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('legacy display label becomes a readable title and editable HTML content', async () => {
  const { window } = installDomEnvironment()
  try {
    const draft = quickButtonToDraft({
      id: 'old-link', label: '<a href="https://example.com">新闻</a>', prompt: '', kind: 'display',
    })
    assert.equal(draft.label, '新闻')
    assert.equal(draft.content, '<a href="https://example.com">新闻</a>')
  } finally {
    await window.happyDOM.close()
  }
})

test('workflow and stage shortcut editors can add buttons without crypto.randomUUID', async () => {
  const { window } = installDomEnvironment()
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness() {
    const [workflowButtons, setWorkflowButtons] = useState<QuickButtonDraft[]>([])
    const [stageButtons, setStageButtons] = useState<ReturnType<typeof quickButtonFromDraft>[]>([])
    const [selected, setSelected] = useState('')
    return <>
      <QuickButtonEditor projectId="project-1" workflowId="workflow-1" buttons={workflowButtons} onChange={setWorkflowButtons} selectedId={selected} onSelect={setSelected} onSave={() => {}} />
      <WorkflowQuickButtonsSection projectId="project-1" workflowId="workflow-1" buttons={stageButtons} onChange={setStageButtons} />
      <output data-testid="button-counts">{workflowButtons.length},{stageButtons.length}</output>
    </>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    const addButtons = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.includes('添加'))
    assert.equal(addButtons.length, 2)
    await act(async () => addButtons[0].click())
    await act(async () => addButtons[1].click())
    assert.equal(container.querySelector('[data-testid="button-counts"]')?.textContent, '1,1')
  } finally {
    await act(async () => root.unmount())
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto)
    else Reflect.deleteProperty(globalThis, 'crypto')
    container.remove()
    await window.happyDOM.close()
  }
})
