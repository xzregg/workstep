import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import EngineRuntimeControl from '../src/components/EngineRuntimeControl'

const catalog = {
  current_version: '0.149.0', default_version: '0.150.0', rollback_version: '0.148.0',
  versions: [{ version: '0.150.0', size_bytes: 1048576, prerelease: false }, { version: '0.149.0', size_bytes: 512, prerelease: false }],
  history: [], requires_terms: false, configured_path: null,
}

test('selects an exact version and rollback confirms the saved target', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch
  const submitted: unknown[] = []
  let catalogReads = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      submitted.push(JSON.parse(String(init.body)))
      return Response.json({ id: 'op1', status: 'failed', stage: 'failed', message: '磁盘空间不足', target_version: '0.150.0' })
    }
    if (url.endsWith('/operation')) return Response.json(null)
    catalogReads++
    return Response.json(catalog)
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label)!
  try {
    await act(async () => root.render(<I18nProvider><EngineRuntimeControl engineId="codex_sdk" onChanged={() => {}} /></I18nProvider>))
    await act(async () => button('安装与版本').click())
    assert.equal(catalogReads, 1)
    assert.equal(document.querySelector('select')?.value, '0.150.0')
    assert.match(document.body.textContent!, /1 MiB/)
    await act(async () => button('安装所选版本').click())
    assert.equal(document.querySelector('[role="dialog"]') !== null, true)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /0.149.0.*0.150.0/)
    await act(async () => button('确认安装').click())
    assert.deepEqual(submitted[0], { version: '0.150.0', rollback: false, accept_third_party_terms: false })
    assert.match(document.body.textContent!, /磁盘空间不足/)
    await act(async () => button('回退到 0.148.0').click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /0.148.0/)
    await act(async () => button('确认回退').click())
    assert.deepEqual(submitted[1], { rollback: true, accept_third_party_terms: false })
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('restores a running operation and measures download without overlapping polling', async (context) => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch
  let polls = 0
  let changes = 0
  globalThis.fetch = async input => {
    if (!String(input).endsWith('/operation')) return Response.json(catalog)
    polls++
    return Response.json({ id: 'restored', status: polls > 1 ? 'succeeded' : 'running', stage: polls > 1 ? 'completed' : 'downloading',
      downloaded_bytes: 524288, total_bytes: 1048576, message: polls > 1 ? '版本切换完成' : '' })
  }
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><EngineRuntimeControl engineId="codex_sdk" onChanged={() => { changes++ }} /></I18nProvider>))
    assert.equal(polls, 1)
    assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '50')
    assert.equal(Array.from(document.querySelectorAll('button')).find(b => b.textContent === '安装所选版本')?.disabled, true)
    await act(async () => context.mock.timers.tick(500))
    assert.equal(polls, 2)
    assert.equal(changes, 1)
    assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '100')
    await act(async () => context.mock.timers.tick(5000))
    assert.equal(polls, 2)
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('reopening the panel shares an in-flight catalog request', async () => {
  const { document, window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let reads = 0
  let release!: (value: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  globalThis.fetch = async input => {
    if (String(input).endsWith('/operation')) return Response.json(null)
    reads++
    return pending
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const toggle = () => Array.from(document.querySelectorAll('button')).find(b => b.textContent === '安装与版本')!
  try {
    await act(async () => root.render(<I18nProvider><EngineRuntimeControl engineId="codex_sdk" onChanged={() => {}} /></I18nProvider>))
    await act(async () => toggle().click())
    await act(async () => toggle().click())
    await act(async () => toggle().click())
    assert.equal(reads, 1)
  } finally {
    await act(async () => { release(Response.json(catalog)) })
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('a failed initial progress read retries before allowing another installation', async (context) => {
  const { document, window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = async input => {
    if (!String(input).endsWith('/operation')) return Response.json(catalog)
    reads++
    if (reads === 1) throw new Error('connection lost')
    return Response.json(null)
  }
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label)!
  try {
    await act(async () => root.render(<I18nProvider><EngineRuntimeControl engineId="codex_sdk" onChanged={() => {}} /></I18nProvider>))
    await act(async () => button('安装与版本').click())
    assert.equal(button('安装所选版本').disabled, true)
    await act(async () => context.mock.timers.tick(2000))
    assert.equal(reads, 2)
    assert.equal(button('安装所选版本').disabled, false)
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
