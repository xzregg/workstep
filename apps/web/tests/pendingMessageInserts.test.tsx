import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import PendingMessageInserts from '../src/components/PendingMessageInserts'
import { I18nProvider } from '../src/i18n'
import { resolveMarkdownImageSrc } from '../src/utils/markdownImages'

test('pending messages render uploaded images, preview them and preserve edit source', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const content = '![截图](.workstep/uploads/screen.png) 这个去掉'
  const item = { id: 'insert-1', content }
  let edited: unknown
  let sent: unknown
  const props = {
    projectId: 'project-1', items: [item], title: '待处理消息', titleTooltip: '',
    onEditStart: (value: unknown) => { edited = value },
    onSend: (value: unknown) => { sent = value },
  }
  try {
    await act(async () => root.render(<I18nProvider><PendingMessageInserts {...props} /></I18nProvider>))
    const image = container.querySelector('img')
    assert.ok(image, '应渲染图片而非 Markdown 源码')
    assert.equal(image.getAttribute('src'), resolveMarkdownImageSrc('.workstep/uploads/screen.png', 'project-1'))
    assert.equal(image.getAttribute('alt'), '截图')
    assert.equal(container.querySelector('.pending-insert-content')?.textContent, ' 这个去掉')
    await act(async () => container.querySelector<HTMLButtonElement>('.markdown-image-click')!.click())
    assert.ok(document.querySelector('.image-preview'))
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })))
    assert.equal(document.querySelector('.image-preview'), null)
    await act(async () => container.querySelector<HTMLButtonElement>('.pending-insert-button--send')!.click())
    assert.deepEqual(sent, item)
    // 图标按钮依次为编辑和删除。
    await act(async () => container.querySelector<HTMLButtonElement>('.pending-insert-button--icon')!.click())
    assert.deepEqual(edited, item)
    await act(async () => root.render(<I18nProvider><PendingMessageInserts {...props} editingId={item.id} editingContent={content} /></I18nProvider>))
    assert.equal(container.querySelector('textarea')?.value, content)
    assert.equal(container.querySelector('.pending-insert-content'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
