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
      if (failure === 'error') window.dispatchEvent(new window.ErrorEvent('error', { message: 'startup failure', filename: 'https://gateway.test/workspace/device/assets/app.js' }))
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


test('startup retry fetches a fresh entry while preserving workspace, query and hash', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/workspace/device/chat?session=keep#message')
  window.document.body.innerHTML = '<div id="root"><div class="app-loading">Loading</div></div>'
  try {
    window.eval(html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)![1])
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'startup failure', filename: 'https://gateway.test/workspace/device/assets/app.js' }))
    ;(window.document.querySelector('button') as HTMLButtonElement).click()
    const target = new URL(window.location.href)
    assert.equal(target.pathname, '/workspace/device/chat')
    assert.equal(target.searchParams.get('session'), 'keep')
    assert.equal(target.hash, '#message')
    assert.ok(target.searchParams.get('_workstep_reload'))
  } finally { await window.happyDOM.close() }
})

test('unrelated scripts and extension errors do not turn a slow startup into a failure', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/workspace/device/')
  window.document.body.innerHTML = '<div id="root"><div class="app-loading">Loading</div></div>'
  try {
    window.eval(html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)![1])
    for (const src of ['https://static.cloudflareinsights.com/beacon.min.js', 'chrome-extension://extension/content.js', 'https://gateway.test/analytics.js']) {
      const script = window.document.createElement('script')
      script.src = src
      window.document.body.appendChild(script)
      script.dispatchEvent(new window.Event('error', { bubbles: false }))
      window.dispatchEvent(new window.ErrorEvent('error', { filename: src, message: 'unrelated failure' }))
      const rejection = new window.Event('unhandledrejection')
      Object.defineProperty(rejection, 'reason', { value: { stack: `Error: unrelated\n    at ${src}:1:1` } })
      window.dispatchEvent(rejection)
    }
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'Script error.' }))
    assert.equal(window.document.querySelector('[role=alert]'), null)
    assert.equal(window.document.querySelector('.app-loading')?.textContent, 'Loading')
    window.document.getElementById('root')!.innerHTML = '<main>Ready</main>'
    assert.equal(window.document.querySelector('main')?.textContent, 'Ready')
  } finally { await window.happyDOM.close() }
})

test('application module resource failures and rejected startup code still expose recovery', async () => {
  for (const failure of ['resource', 'rejection']) {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL('https://gateway.test/workspace/device/')
    window.document.body.innerHTML = '<div id="root"><div class="app-loading">Loading</div></div>'
    try {
      window.eval(html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)![1])
      if (failure === 'resource') {
        const script = window.document.createElement('script')
        script.src = '/workspace/device/assets/app.js'
        window.document.body.appendChild(script)
        script.dispatchEvent(new window.Event('error'))
      } else {
        const rejection = new window.Event('unhandledrejection')
        Object.defineProperty(rejection, 'reason', { value: { stack: 'Error: failed\n    at https://gateway.test/workspace/device/assets/app.js:1:1' } })
        window.dispatchEvent(rejection)
      }
      assert.ok(window.document.querySelector('[role=alert]'), failure)
    } finally { await window.happyDOM.close() }
  }
})

test('missing lazy assets trigger one fresh navigation, then expose recovery on repeat failure', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/workspace/device/tasks?task=keep')
  window.document.body.innerHTML = '<div id="root"><main>Ready</main></div>'
  try {
    const script = html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)![1]
    window.eval(script)
    const event = new window.Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
    assert.ok(new URL(window.location.href).searchParams.get('_workstep_reload'))
    window.document.body.innerHTML = '<div id="root"><div class="app-loading">Loading</div></div>'
    window.eval(script)
    const before = window.location.href
    window.dispatchEvent(new window.Event('vite:preloadError', { cancelable: true }))
    assert.equal(window.location.href, before)
    assert.ok(window.document.querySelector('[role=alert]'))
  } finally { await window.happyDOM.close() }
})


test('remote startup leaves time for queued asset recovery and local startup stays bounded', async () => {
  for (const [path, expected] of [['/workspace/device/', 90000], ['/', 25000]] as const) {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL(`https://gateway.test${path}`)
    window.document.body.innerHTML = '<div id="root"><div class="app-loading">Loading</div></div>'
    let delay: number | undefined
    window.setTimeout = ((_callback: () => void, ms: number) => { delay = ms; return 1 }) as typeof window.setTimeout
    try {
      window.eval(html.match(/<script id="workstep-startup-guard">([\s\S]*?)<\/script>/)![1])
      assert.equal(delay, expected)
    } finally { await window.happyDOM.close() }
  }
})
