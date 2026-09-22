import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { StatisticsUserTable } from '../src/pages/StatisticsPage'
import { I18nProvider } from '../src/i18n'

test('statistics user table renders per-user token and cost totals', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <StatisticsUserTable
            rows={[{
              author_id: 'user-a', author_name: '小王', call_count: 3,
              input_tokens: 1000, output_tokens: 200,
              cache_read_tokens: 300, cache_write_tokens: 0,
              total_tokens: 1200, cost: 0.25,
            }]}
            locale="zh-CN"
            currency="CNY"
          />
        </I18nProvider>,
      )
    })
    assert.match(container.textContent || '', /用户统计/)
    assert.match(container.textContent || '', /小王/)
    assert.match(container.textContent || '', /1,200/)
    assert.match(container.textContent || '', /¥0.25/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
