const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

for (const newline of ['\n', '\r\n']) {
  test(`syncs application versions with ${newline === '\n' ? 'LF' : 'CRLF'} files`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-version-test-'))
    try {
      for (const name of ['scripts', 'apps/desktop', 'apps/daemon']) fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.copyFileSync(path.join(__dirname, '../sync-app-version.cjs'), path.join(root, 'scripts/sync-app-version.cjs'))
      fs.writeFileSync(path.join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }))
      fs.writeFileSync(path.join(root, 'apps/daemon/pyproject.toml'), `[project]${newline}version = "1.0.0"${newline}`)
      fs.writeFileSync(path.join(root, 'apps/daemon/uv.lock'), `[[package]]${newline}name = "workstep-daemon"${newline}version = "1.0.0"${newline}`)
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/sync-app-version.cjs')], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      for (const file of ['pyproject.toml', 'uv.lock']) {
        const data = fs.readFileSync(path.join(root, 'apps/daemon', file), 'utf8')
        assert.match(data, /version = "1\.2\.3"/)
        assert.equal(data.includes('\r\n'), newline === '\r\n')
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}
