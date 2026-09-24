import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import QuickButtonEditor, { quickButtonFromDraft, quickButtonToDraft, type QuickButtonDraft } from '../src/components/QuickButtonEditor'
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
