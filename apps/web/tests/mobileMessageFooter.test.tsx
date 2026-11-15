import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageResponseFooter from '../src/components/MessageResponseFooter'
import { I18nProvider, useLocaleStore } from '../src/i18n'

for (const compact of [false, true]) {
  test(`mobile footer uses identity then inline usage marquee (compact=${compact})`, async () => {
    const { window, document } = installDomEnvironment()
    window.innerWidth = 390
    useLocaleStore.setState({ locale: 'zh-CN' })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const render = (running = false) => root.render(<I18nProvider>
      <MessageResponseFooter content="回复" engine="codex" model="gpt-6.1-sol" compact={compact}
        usage={{ input_tokens: 79341, output_tokens: 59 }} running={running}
        eventSummary={{ output_rate_sample: { units: 24, elapsed_ms: 2000 } }} />
    </I18nProvider>)
    try {
      await act(async () => render())
      const summary = () => container.querySelector<HTMLButtonElement>('.footer-usage-toggle')!
      assert.ok(summary())
      assert.equal(summary().textContent, 'Codex CLI / gpt-6.1-sol')
      assert.equal(container.querySelector('details'), null)
      await act(async () => summary().click())
      assert.match(summary().textContent!, /79,341/)
      assert.ok(summary().querySelector('.ws-marquee'))
      assert.equal(summary().getAttribute('aria-pressed'), 'true')
      await act(async () => summary().click())
      assert.equal(summary().textContent, 'Codex CLI / gpt-6.1-sol')
      await act(async () => summary().click())
      await act(async () => render(true))
      assert.ok(summary().querySelector('.ws-marquee'))
      assert.match(summary().textContent!, /79,341/)
      assert.match(summary().textContent!, /3 t\/s/)
      assert.equal(summary().getAttribute('aria-pressed'), 'true')
      await act(async () => render(false))
      assert.equal(summary().textContent, 'Codex CLI / gpt-6.1-sol')
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}
