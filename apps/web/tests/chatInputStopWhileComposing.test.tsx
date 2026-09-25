import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

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
  assert.match(markup, /aria-label="发送"/)
  assert.doesNotMatch(markup, /aria-label="停止"/)
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
  assert.match(markup, /aria-label="停止"/)
  assert.doesNotMatch(markup, /aria-label="发送"/)
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
