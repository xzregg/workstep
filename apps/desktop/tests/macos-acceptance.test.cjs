const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { validateOptions, stopChild } = require('../../../scripts/macos-desktop-acceptance.cjs')
const env = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp/github-macos' }
test('macOS acceptance requires disposable runner and an explicit native architecture', () => {
  const input = { installer: 'WorkStep-macos-x64.dmg', version: 'v1.0.13', arch: 'x64' }
  assert.equal(validateOptions(input, 'darwin', env).machine, 'x86_64')
  assert.equal(validateOptions({ ...input, arch: 'arm64' }, 'darwin', env).machine, 'arm64')
  assert.equal(validateOptions(input, 'darwin', env).version, '1.0.13')
  assert.throws(() => validateOptions(input, 'darwin', {}), /disposable/)
  assert.throws(() => validateOptions(input, 'linux', env), /disposable/)
  assert.throws(() => validateOptions({ ...input, arch: 'ia32' }, 'darwin', env), /architecture/)
  assert.throws(() => validateOptions({ ...input, version: 'latest' }, 'darwin', env), /version/)
  assert.throws(() => validateOptions({ ...input, installer: 'app.zip' }, 'darwin', env), /DMG/)
})

test('failed macOS acceptance terminates its own child even if SIGTERM is ignored', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    await once(child.stdout, 'data')
    await stopChild(child, 25)
    assert.equal(child.signalCode, 'SIGKILL')
    await stopChild(child, 25)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})
