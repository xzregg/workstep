const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const script = path.resolve(__dirname, '../extract-release-notes.cjs')
function extract(tag, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-release-notes-'))
  try {
    const file = path.join(directory, 'CHANGELOG.md')
    fs.writeFileSync(file, content)
    return spawnSync(process.execPath, [script, tag, file], { encoding: 'utf8' })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('extracts only the requested version and retains subsections', () => {
  const result = extract('v1.0.16', '# Changelog\n\n## Unreleased\n\n- Future work.\n\n## 1.0.16\n\n### Fixed\n\n- Restore sessions.\n\n## 1.0.15\n\n- Older work.\n')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '### Fixed\n\n- Restore sessions.\n')
})

for (const [name, tag, body] of [
  ['missing version', 'v1.0.17', '## 1.0.16\n\n- Work.\n'],
  ['empty version', 'v1.0.16', '## 1.0.16\n\n## 1.0.15\n\n- Work.\n'],
  ['non-semver tag', 'main', '## main\n\n- Work.\n'],
  ['Chinese release prose', 'v1.0.16', '## 1.0.16\n\n- 修复更新。\n'],
  ['duplicate version', 'v1.0.16', '## 1.0.16\n\n- First.\n\n## 1.0.16\n\n- Second.\n'],
]) {
  test(`rejects ${name}`, () => {
    const result = extract(tag, body)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
  })
}
