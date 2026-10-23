import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('startup failure and timeout replace the spinner with recovery actions, without React', async () => {
  for (const failure of ['error', 'timeout']) {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL('https://gateway.test/workspace/device/chat?session=keep')
    window.document.body.innerHTML = '<div id="root"><div class="app-loading">正在加载 WorkStep…</div></div>'
    let timeout: (() => void) | undefined
    window.setTimeout = ((callback: () => void) => { timeout = callback; return 1 }) as typeof window.setTimeout
    try {
      const script = html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)?.[1]
      assert.ok(script, 'guard must run independently before the module entry')
      window.eval(script)
      if (failure === 'error') window.dispatchEvent(new window.ErrorEvent('error', { message: 'startup failure' }))
      else timeout!()
      assert.equal(window.document.querySelector('.app-loading-spinner'), null)
      assert.ok(window.document.querySelector('[role=alert]'))
      assert.match(window.document.body.textContent!, /重新加载/)
      assert.equal(window.document.querySelector('a')?.getAttribute('href'), '/devices')
    } finally { await window.happyDOM.close() }
  }
})

test('startup guard leaves a mounted application alone', async () => {
  const { window } = installDomEnvironment()
  window.document.body.innerHTML = '<div id="root"><div class="app-loading">Loading</div></div>'
  let timeout: (() => void) | undefined
  window.setTimeout = ((callback: () => void) => { timeout = callback; return 1 }) as typeof window.setTimeout
  try {
    const script = html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)?.[1]
    assert.ok(script)
    window.eval(script)
    window.document.getElementById('root')!.innerHTML = '<main>Ready</main>'
    window.dispatchEvent(new window.ErrorEvent('error'))
    timeout!()
    assert.equal(window.document.querySelector('main')?.textContent, 'Ready')
  } finally { await window.happyDOM.close() }
})
