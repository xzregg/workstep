import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserDiagnostics, installBrowserDiagnostics, buildBrowserFeedback } from '../src/utils/browserDiagnostics'

test('browser diagnostics retain bounded redacted records and allowlisted request metadata only', () => {
  const diagnostics = createBrowserDiagnostics(() => ({ identities: ['私人项目', 'Alice'] }))
  diagnostics.recordError(new Error('私人项目 user_name=Alice password="secret with spaces"'))
  diagnostics.recordRequestFailure('/projects/private-id/tasks/abc?token=private-token', 'POST', 500)
  const snapshot = JSON.stringify(diagnostics.snapshot())
  for (const secret of ['私人项目', 'Alice', 'secret with spaces', 'private-id', 'abc', 'private-token']) assert.ok(!snapshot.includes(secret), secret)
  assert.match(snapshot, /POST \/projects\/:id\/tasks\/:id HTTP 500/)
  diagnostics.recordError({ payload: 'private chat', toString() { throw Error('do not inspect bodies') } })
  for (let index = 0; index < 200; index++) diagnostics.recordError(new Error(`failure ${index} ${'错'.repeat(5000)}`))
  assert.ok(diagnostics.snapshot().length <= 100)
  assert.ok(new TextEncoder().encode(JSON.stringify(diagnostics.snapshot())).length < 256 * 1024)
})

test('error listeners install once and dispose; unknown rejection objects are not serialized', async () => {
  const { window } = installDomEnvironment()
  const diagnostics = createBrowserDiagnostics()
  const dispose = installBrowserDiagnostics(window as unknown as Window, diagnostics)
  installBrowserDiagnostics(window as unknown as Window, diagnostics)
  const event = new window.ErrorEvent('error', { error: new Error('token=hidden') })
  window.dispatchEvent(event)
  assert.equal(diagnostics.snapshot().length, 1)
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('hidden'))
  window.dispatchEvent(new window.Event('unhandledrejection'))
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('undefined'))
  dispose()
  const count = diagnostics.snapshot().length
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'after disposal' }))
  assert.equal(diagnostics.snapshot().length, count)
  await window.happyDOM.close()
})

test('browser report contains version and uptime but no origin, search parameters or raw user agent', async () => {
  const { window } = installDomEnvironment()
  window.location.href = 'http://10.0.0.1/chat?project=private-project&token=private-token'
  const report = buildBrowserFeedback({ window: window as unknown as Window, diagnostics: createBrowserDiagnostics(), version: '1.0.17' })
  for (const value of ['1.0.17', '页面运行时长', '后台文件日志', '不可用']) assert.ok(report.includes(value), value)
  for (const value of ['10.0.0.1', 'private-project', 'private-token']) assert.ok(!report.includes(value), value)
  await window.happyDOM.close()
})

test('copied browser feedback summarizes the latest five distinct errors instead of its full buffer', async () => {
  const { window } = installDomEnvironment()
  const diagnostics = createBrowserDiagnostics()
  for (let index = 0; index < 20; index++) diagnostics.recordError(`Error: failure-${index}\n    at handler ([path]:12:3)\n${'    at extra ([path]:10:1)\n'.repeat(100)}`)
  diagnostics.recordError('Error: failure-19\n    at handler ([path]:12:3)\n    at extra ([path]:10:1)')
  const report = buildBrowserFeedback({ window: window as unknown as Window, diagnostics })
  assert.ok(new TextEncoder().encode(report).length <= 8192)
  assert.equal(report.match(/Error: failure-/g)?.length, 5)
  assert.ok(!report.includes('Error: failure-0\n'))
  assert.match(report, /最多 5 类/)
  assert.ok(report.split('\n').length < 40)
  await window.happyDOM.close()
})
