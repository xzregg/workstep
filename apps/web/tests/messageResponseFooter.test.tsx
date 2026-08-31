import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../src/i18n/index.tsx'
import MessageResponseFooter from '../src/components/MessageResponseFooter.tsx'


test('fork action renders immediately before copy in the response footer', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <MessageResponseFooter content="完成" onFork={() => {}} />
    </I18nProvider>,
  )

  const forkIndex = html.indexOf('aria-label="分叉"')
  const copyIndex = html.indexOf('aria-label="复制消息"')
  assert.notEqual(forkIndex, -1)
  assert.notEqual(copyIndex, -1)
  assert.ok(forkIndex < copyIndex)
})
