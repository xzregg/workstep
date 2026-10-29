import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TrendChart } from '../src/pages/StatisticsPage'

test('token trend renders separated, proportional bars and retains accessible daily tooltips', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const data = [0, 500, 1000].map((total_tokens, index) => ({
    bucket: `2026-10-${27 + index}`, total_tokens, succeeded_runs: index, failed_runs: 0,
  }))
  const render = async (points = data, mode: 'tokens' | 'runs' = 'tokens') => {
    await act(async () => root.render(<TrendChart title="Token 消耗趋势" data={points} mode={mode}
      successLabel="成功" failedLabel="失败" totalTokensLabel="Token 总量" locale="zh-CN" />))
  }
  try {
    await render()
    const bars = [...container.querySelectorAll('.statistics-chart-bar')]
    assert.equal(bars.length, 3)
    assert.equal(container.querySelectorAll('polyline').length, 0)
    assert.deepEqual(bars.map((bar) => Number(bar.getAttribute('height'))), [0, 75, 150])
    bars.forEach((bar) => {
      assert.equal(Number(bar.getAttribute('y')) + Number(bar.getAttribute('height')), 150)
      assert.ok(Number(bar.getAttribute('width')) < 200)
      assert.ok(Number(bar.getAttribute('x')) >= 0)
      assert.ok(Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) <= 600)
    })
    const targets = container.querySelectorAll<SVGElement>('.statistics-chart-hit-area')
    assert.match(targets[2].getAttribute('aria-label') || '', /2026-10-29 · Token 总量 1,000/)
    await act(async () => targets[2].focus())
    assert.match(container.querySelector('[role="status"]')?.textContent || '', /1,000/)
    assert.equal(bars[2].getAttribute('data-active'), 'true')
    await act(async () => targets[2].blur())
    assert.equal(container.querySelector('[role="status"]'), null)
    await render([data[2]])
    const single = container.querySelector('.statistics-chart-bar')!
    assert.equal(Number(single.getAttribute('x')) + Number(single.getAttribute('width')) / 2, 300)
    await render([data[0]])
    assert.equal(container.querySelector('.statistics-chart-bar')?.getAttribute('height'), '0')
    await render([])
    assert.equal(container.querySelectorAll('.statistics-chart-bar').length, 0)
    await render(data, 'runs')
    assert.equal(container.querySelectorAll('polyline').length, 2)
    assert.equal(container.querySelectorAll('.statistics-chart-bar').length, 0)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
