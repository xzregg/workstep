import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import ProblemFeedbackSettings from '../src/components/ProblemFeedbackSettings'
import { installDomEnvironment } from './helpers/domEnv'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { browserDiagnostics } from '../src/utils/browserDiagnostics'

for (const android of [false, true]) {
  test(`${android ? 'Android' : 'browser'} feedback copies redacted diagnostics and offers manual fallback`, async () => {
    const { window } = installDomEnvironment()
    if (android) window.WorkStepAndroid = { postMessage() {} }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const writes: string[] = []
    let fail = false
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (text: string) => {
      if (fail) throw Error('clipboard denied')
      writes.push(text)
    } } })
    browserDiagnostics.clear()
    browserDiagnostics.recordError(new Error('password=private-password'))
    try {
      useLocaleStore.setState({ locale: 'zh-CN' })
      await act(async () => root.render(<I18nProvider><ProblemFeedbackSettings /></I18nProvider>))
      const button = container.querySelector<HTMLButtonElement>('button')!
      await act(async () => button.click())
      assert.equal(writes.length, 1)
      assert.ok(!writes[0].includes('private-password'))
      if (android) assert.match(writes[0], /客户端：Android/)
      assert.match(container.querySelector('[role="status"]')?.textContent || '', /已复制/)
      assert.match(container.textContent || '', /系统截图.*敏感内容/)
      const report = container.querySelector<HTMLTextAreaElement>('textarea')!
      assert.equal(report.readOnly, true)
      assert.equal(report.value, writes[0])
      fail = true
      await act(async () => button.click())
      assert.match(container.querySelector('[role="alert"]')?.textContent || '', /手动复制/)
      assert.equal(document.activeElement, report)
      assert.equal(writes.length, 1)
      fail = false
      await act(async () => button.click())
      assert.equal(container.querySelector('[role="alert"]'), null)
    } finally {
      browserDiagnostics.clear()
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}

test('feedback opens the GitHub bug form in a separate browser page', () => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  const html = renderToStaticMarkup(<I18nProvider><ProblemFeedbackSettings /></I18nProvider>)
  assert.match(html, /反馈问题/)
  assert.match(html, /href="https:\/\/github.com\/xzregg\/workstep\/issues\/new\?template=bug_report.yml"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('desktop feedback opens the shared window, prevents duplicate requests and retries errors', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let calls = 0, release!: () => void, fail = false
  window.workstepDesktop = { notify() {}, feedback: { open: async () => {
    calls++
    if (fail) throw Error('window failed')
    await new Promise<void>(resolve => { release = resolve })
  } } }
  try {
    await act(async () => root.render(<I18nProvider><ProblemFeedbackSettings /></I18nProvider>))
    const button = container.querySelector<HTMLButtonElement>('button')!
    assert.match(button.textContent || '', /一键反馈/)
    await act(async () => button.click())
    assert.equal(button.disabled, true)
    await act(async () => button.click())
    assert.equal(calls, 1)
    await act(async () => release())
    assert.equal(button.disabled, false)
    fail = true
    await act(async () => button.click())
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /window failed/)
    fail = false
    await act(async () => button.click())
    await act(async () => release())
    assert.equal(container.querySelector('[role="alert"]'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
