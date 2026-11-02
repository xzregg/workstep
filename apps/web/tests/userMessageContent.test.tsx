import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('user messages collapse overflow, expand and collapse again, and remeasure on resize', async () => {
  const { window } = installDomEnvironment()
  const previousLocale = useLocaleStore.getState().locale
  useLocaleStore.getState().setLocale('zh-CN')
  let height = 120
  const originalStyle = globalThis.getComputedStyle
  globalThis.getComputedStyle = ((element: Element) => element.classList.contains('user-message-content-body')
    ? { lineHeight: '20px' } : originalStyle(element)) as typeof getComputedStyle
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return height } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const content = Array.from({ length: 6 }, (_, i) => `第${i + 1}行`).join('\n')
  const render = async (role: 'user' | 'assistant', text = content) => {
    await act(async () => root.render(<I18nProvider><ChatMessageBubble
      role={role} sender="测试" initials="测" color="#123456" content={text}
    /></I18nProvider>))
  }
  const toggle = () => container.querySelector<HTMLButtonElement>('.user-message-content-toggle')
  try {
    await render('user')
    assert.equal(toggle()?.textContent, '更多')
    assert.equal(toggle()?.getAttribute('aria-expanded'), 'false')
    assert.ok(container.querySelector('.user-message-content-body--collapsed'))
    assert.equal(container.querySelector('.user-message-markdown')?.textContent, content)
    await act(async () => toggle()!.click())
    assert.equal(toggle()?.textContent, '收起')
    assert.equal(toggle()?.getAttribute('aria-expanded'), 'true')
    assert.equal(container.querySelector('.user-message-content-body--collapsed'), null)
    await act(async () => toggle()!.click())
    assert.equal(toggle()?.getAttribute('aria-expanded'), 'false')
    height = 100
    await act(async () => window.dispatchEvent(new window.Event('resize')))
    assert.equal(toggle(), null, 'exactly five lines need no toggle')
    height = 120
    await act(async () => window.dispatchEvent(new window.Event('resize')))
    assert.equal(toggle()?.textContent, '更多', 'wrapped overflow is remeasured')
    await act(async () => toggle()!.click())
    await render('user', '另一条长消息')
    assert.equal(toggle()?.getAttribute('aria-expanded'), 'false', 'new content defaults to collapsed')
    await render('assistant')
    assert.equal(toggle(), null, 'assistant messages remain fully visible')
  } finally {
    await act(async () => root.unmount())
    useLocaleStore.getState().setLocale(previousLocale)
    globalThis.getComputedStyle = originalStyle
    container.remove()
    await window.happyDOM.close()
  }
})
