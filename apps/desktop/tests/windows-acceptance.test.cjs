const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  validateVersion, installArguments, verifyChecksum, validateRuntime,
  validatePersistence, waitFor, assertWindowsRunner,
} = require('../../../scripts/windows-desktop-acceptance.cjs')

test('acceptance only runs on a GitHub Windows runner, never the developer desktop', () => {
  assert.throws(() => assertWindowsRunner('darwin', { GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp' }))
  assert.throws(() => assertWindowsRunner('win32', { RUNNER_TEMP: 'C:\\temp' }))
  assertWindowsRunner('win32', { GITHUB_ACTIONS: 'true', RUNNER_TEMP: 'C:\\temp' })
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

test('polling times out as a failure instead of silently skipping acceptance', async () => {
  await assert.rejects(waitFor(async () => false, 'fixture not ready', 15, 1), /fixture not ready/)
  assert.equal(await waitFor(async () => 'ready', 'unused', 15, 1), 'ready')
})
