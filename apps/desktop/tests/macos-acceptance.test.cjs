const test = require('node:test')
const assert = require('node:assert/strict')
const { validateOptions } = require('../../../scripts/macos-desktop-acceptance.cjs')
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
