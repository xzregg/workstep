import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

test('running assistant keeps a separate stop action while a follow-up is drafted', () => {
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
  assert.match(markup, /aria-label="停止"/)
  assert.match(markup, /aria-label="发送"/)
})

test('mobile keeps the stop progress visible while the request is pending', () => {
  const css = readFileSync(new URL('../src/mobile.css', import.meta.url), 'utf8')
  assert.match(css, /\.chat-input-stop:disabled\s*\{\s*display:\s*flex\s*!important;/)
})
