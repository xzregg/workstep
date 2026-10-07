import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import { I18nProvider, useLocaleStore } from '../src/i18n'

for (const signal of ['workstep:resume', 'pageshow', 'visibilitychange']) {
  test(`running elapsed time catches up immediately on ${signal} and stops at completion`, async (context) => {
    const { window, document } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    const start = Date.parse('2026-10-07T05:56:08Z')
    let now = start + 17_000
    context.mock.method(Date, 'now', () => now)
    const ticks = new Map<number, () => void>()
    let nextId = 0
    context.mock.method(window, 'setInterval', (callback: () => void) => {
      ticks.set(++nextId, callback)
      return nextId
    })
    context.mock.method(window, 'clearInterval', (id: number) => { ticks.delete(id) })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const events: [] = []
    const render = (running: boolean) => root.render(<I18nProvider>
      <ProcessTrace events={events} running={running} startedAt={start} endedAt={start + 90_000} />
    </I18nProvider>)
    try {
      await act(async () => render(true))
      const label = () => container.querySelector('.process-trace-session-summary span')!.textContent
      assert.equal(label(), '处理中 17秒')
      now += 1000
      await act(async () => { for (const tick of ticks.values()) tick() })
      assert.equal(label(), '处理中 18秒')
      // Android/browser timers can be suspended while backgrounded.
      now = start + 80_000
      await act(async () => {
        (signal === 'visibilitychange' ? document : window).dispatchEvent(new window.Event(signal))
      })
      assert.equal(label(), '处理中 1分20秒')
      assert.equal(ticks.size, 1)
      await act(async () => render(false))
      assert.equal(label(), '耗时 1分30秒')
      assert.equal(ticks.size, 0)
      now += 20_000
      await act(async () => window.dispatchEvent(new window.Event('workstep:resume')))
      assert.equal(label(), '耗时 1分30秒')
    } finally {
      await act(async () => root.unmount())
      context.mock.restoreAll()
      await window.happyDOM.close()
    }
  })
}
