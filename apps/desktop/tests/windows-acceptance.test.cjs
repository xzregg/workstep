const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const {
  validateVersion, installArguments, verifyChecksum, validateRuntime,
  validatePersistence, validateUninstallMemory, waitFor, assertWindowsRunner, parseApiResponse, fixtureLabels, openSettings, closeDesktop, cleanupBrowser, installCompletionGuard, execute,
} = require('../../../scripts/windows-desktop-acceptance.cjs')

test('acceptance only runs on a GitHub Windows runner, never the developer desktop', () => {
  assert.throws(() => assertWindowsRunner('darwin', { GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp' }))
  assert.throws(() => assertWindowsRunner('win32', { RUNNER_TEMP: 'C:\\temp' }))
  assertWindowsRunner('win32', { GITHUB_ACTIONS: 'true', RUNNER_TEMP: 'C:\\temp' })
})

test('non-JSON API errors retain endpoint, status and response instead of a JSON parsing error', () => {
  assert.throws(() => parseApiResponse('/api/system-settings', 500, 'Internal Server Error'),
    /\/api\/system-settings: HTTP 500: Internal Server Error/)
  assert.deepEqual(parseApiResponse('/api/health', 200, '{"status":"ok"}'), { status: 'ok' })
  assert.throws(() => parseApiResponse('/api/health', 200, 'invalid'), /JSON/)
})

test('acceptance versions reject shell arguments and smoke pseudo versions', () => {
  assert.equal(validateVersion('v1.0.11'), '1.0.11')
  for (const invalid of ['latest', 'smoke-abc', '1.0.11\n/S', '1.0.11;exit']) {
    assert.throws(() => validateVersion(invalid))
  }
})

test('NSIS destination is the final unquoted argument for paths with spaces and Chinese', () => {
  assert.deepEqual(installArguments('C:\\temp\\安装目录 WorkStep'), ['/S', '/currentuser', '/D=C:\\temp\\安装目录 WorkStep'])
})

test('installer execution supports a bounded install-specific timeout without ignoring exit failures', async () => {
  await execute(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], { timeout: 2000, stdio: 'ignore' })
  await assert.rejects(execute(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'],
    { timeout: 25, stdio: 'ignore' }), /timed out after 25ms/)
  await assert.rejects(execute(process.execPath, ['-e', 'process.exit(7)'],
    { timeout: 2000, stdio: 'ignore' }), /exited 7/)
})

test('upgrade seeds old versions with supported ASCII but new installs require Unicode', () => {
  for (const value of Object.values(fixtureLabels(true))) assert.match(value, /^[\x20-\x7e]+$/)
  assert.match(fixtureLabels(false).userName, /中文.*🙂/)
  assert.match(fixtureLabels(false).projectName, /验收/)
})

test('settings opens through the actual collapsed navigation on narrow runner screens', async () => {
  for (const compact of [false, true]) {
    const clicks = []
    const page = {
      locator: selector => { assert.equal(selector, '#workstep-navigation'); return { getAttribute: async () => compact ? '' : null } },
      getByRole: (role, options) => ({ click: async () => { assert.equal(role, 'button'); clicks.push(String(options.name)) } }),
    }
    await openSettings(page)
    assert.deepEqual(clicks, [...(compact ? ['打开导航'] : []), '设置', '/系统设置/'])
  }
})

test('desktop quit completes even when CDP disconnects before acknowledging Browser.close', async () => {
  const browser = new EventEmitter()
  browser.isConnected = () => true
  browser.newBrowserCDPSession = async () => ({ send: () => {
    setTimeout(() => browser.emit('disconnected'), 1)
    return new Promise(() => {})
  } })
  await closeDesktop(browser)
  assert.equal(browser.listenerCount('disconnected'), 0)
  browser.newBrowserCDPSession = async () => ({ send: async () => { throw new Error('protocol failure') } })
  await assert.rejects(closeDesktop(browser), /protocol failure/)
})

test('an unresolved top-level acceptance must not silently exit with success', () => {
  for (const complete of [false, true]) {
    const runtime = new EventEmitter(), errors = []
    runtime.exitCode = 0
    const done = installCompletionGuard(runtime, message => errors.push(message))
    if (complete) done()
    runtime.emit('beforeExit')
    assert.equal(runtime.exitCode, complete ? 0 : 1)
    assert.equal(errors.length, complete ? 0 : 1)
  }
})

test('cleanup does not close an already disconnected desktop a second time', async () => {
  const browser = new EventEmitter()
  browser.isConnected = () => false
  browser.close = () => { assert.fail('closed desktop must not be closed again') }
  await cleanupBrowser(browser)
  browser.isConnected = () => true
  browser.close = () => {
    setTimeout(() => browser.emit('disconnected'), 1)
    return new Promise(() => {})
  }
  await cleanupBrowser(browser)
  assert.equal(browser.listenerCount('disconnected'), 0)
})

test('downloaded installer must match the exact checksum entry', () => {
  const data = Buffer.from('installer fixture')
  const digest = createHash('sha256').update(data).digest('hex')
  verifyChecksum(data, `${digest}  WorkStep-windows-x64.exe\n`)
  assert.throws(() => verifyChecksum(Buffer.from('tampered'), `${digest}  WorkStep-windows-x64.exe\n`))
  assert.throws(() => verifyChecksum(data, `${digest}  other.exe\n`))
  assert.throws(() => verifyChecksum(data, `${digest}  WorkStep-windows-x64.exe\n`.repeat(2)))
})

test('runtime checks both packaged versions and rejects connecting to a port occupier', () => {
  const health = { status: 'ok', version: '1.0.11' }
  const update = { currentVersion: '1.0.11', releaseUrl: 'https://github.com/xzregg/workstep/releases/tag/v1.0.11' }
  validateRuntime('http://127.0.0.1:45678/', health, update, '1.0.11', 8766)
  assert.throws(() => validateRuntime('http://127.0.0.1:8766/', health, update, '1.0.11', 8766))
  assert.throws(() => validateRuntime('https://example.com/', health, update, '1.0.11'))
  assert.throws(() => validateRuntime('http://127.0.0.1:45678/', { ...health, version: '1.0.10' }, update, '1.0.11'))
  assert.throws(() => validateRuntime('http://127.0.0.1:45678/', health, { ...update, currentVersion: '1.0.10' }, '1.0.11'))
})

test('restart and upgrade must preserve IDs, task content and project memory', () => {
  const fixture = { projectId: 'p', taskId: 't', title: '验收任务', memory: '# 验收记忆' }
  const projects = { projects: [{ id: 'p' }] }
  const task = { id: 't', title: '验收任务' }
  validatePersistence(fixture, projects, task, { content: '# 验收记忆' })
  assert.throws(() => validatePersistence(fixture, { projects: [] }, task, { content: '# 验收记忆' }))
  assert.throws(() => validatePersistence(fixture, projects, { ...task, id: 'replacement' }, { content: '# 验收记忆' }))
  assert.throws(() => validatePersistence(fixture, projects, task, { content: '' }))
})

test('uninstall retains exact bytes while accepting Windows-native CRLF in the original file', () => {
  const before = Buffer.from('# 中文记忆\r\n\r\n保留🙂\r\n')
  const expected = '# 中文记忆\n\n保留🙂\n'
  validateUninstallMemory(before, Buffer.from(before), expected)
  assert.throws(() => validateUninstallMemory(before, Buffer.from(expected), expected))
  assert.throws(() => validateUninstallMemory(before, before, 'lost content'))
})

test('polling times out as a failure instead of silently skipping acceptance', async () => {
  await assert.rejects(waitFor(async () => false, 'fixture not ready', 15, 1), /fixture not ready/)
  assert.equal(await waitFor(async () => 'ready', 'unused', 15, 1), 'ready')
})
