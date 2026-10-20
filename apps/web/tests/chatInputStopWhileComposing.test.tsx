import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test.beforeEach(() => useLocaleStore.setState({ locale: 'zh-CN' }))

test('running assistant shows only send while a follow-up is drafted', () => {
  const markup = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(ChatInput, {
      value: '后续消息',
      onChange: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
      running: true,
      allowSendWhileRunning: true,
    }),
  ))
  assert.match(markup, /data-state="active"/)
  assert.doesNotMatch(markup, /class="chat-input-stop-glyph"/)
  assert.equal((markup.match(/class="chat-input-send"/g) || []).length, 1)
})

test('running assistant shows only stop when the input is empty', () => {
  const markup = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(ChatInput, {
      value: '',
      onChange: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
      running: true,
      allowSendWhileRunning: true,
    }),
  ))
  assert.match(markup, /data-state="stopped"/)
  assert.match(markup, /class="chat-input-stop-glyph"/)
  assert.equal((markup.match(/class="chat-input-send"/g) || []).length, 1)
})

test('mobile keeps the single stop button visible while stopping', () => {
  const markup = renderToStaticMarkup(createElement(
    I18nProvider,
    null,
    createElement(ChatInput, {
      value: '',
      onChange: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
      running: true,
      allowSendWhileRunning: true,
      stopping: true,
    }),
  ))
  assert.match(markup, /class="chat-input-send"[^>]*data-state="stopped"[^>]*disabled/)
  const css = readFileSync(new URL('../src/mobile.css', import.meta.url), 'utf8')
  assert.match(css, /\.chat-input-send\[data-state="stopped"\]:disabled\s*\{\s*display:\s*flex\s*!important;/)
})

for (const width of [320, 390, 1023]) {
  test(`coordinator composer sends a follow-up and stops without mixing actions at ${width}px`, async () => {
    const { window } = installDomEnvironment()
    window.innerWidth = width
    useLocaleStore.setState({ locale: 'zh-CN' })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    let sends = 0, stops = 0
    const render = (value: string, running: boolean, stopping = false) => root.render(createElement(
      I18nProvider, null, createElement(ChatInput, {
        value, running, stopping, allowSendWhileRunning: true,
        onChange: () => {}, onSend: () => { sends++ }, onStop: () => { stops++ },
      }),
    ))
    try {
      await act(async () => render('补充要求', true))
      await act(async () => container.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
      assert.deepEqual([sends, stops], [1, 0])
      await act(async () => render('', true))
      assert.equal(container.querySelector('.chat-input-send')!.getAttribute('aria-label'), '停止')
      await act(async () => container.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
      assert.deepEqual([sends, stops], [1, 1])
      await act(async () => render('', true, true))
      assert.equal(container.querySelector<HTMLButtonElement>('.chat-input-send')!.disabled, true)
      await act(async () => container.querySelector<HTMLButtonElement>('.chat-input-send')!.click())
      assert.deepEqual([sends, stops], [1, 1])
      await act(async () => render('下一轮', false))
      assert.equal(container.querySelector('.chat-input-send')!.getAttribute('aria-label'), '发送')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}
