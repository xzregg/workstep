const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { validateIcons, iconFiles } = require('../scripts/check-icons.cjs')
const desktop = path.resolve(__dirname, '..')

test('SVG icon sources are checked out with canonical LF even on Windows', () => {
  const attributes = execFileSync('git', ['check-attr', 'eol', '--',
    'apps/web/public/favicon.svg', 'apps/desktop/build/app-icon.svg'], {
    cwd: path.resolve(desktop, '../..'), encoding: 'utf8',
  })
  assert.deepEqual(attributes.trim().split(/\r?\n/), [
    'apps/web/public/favicon.svg: eol: lf',
    'apps/desktop/build/app-icon.svg: eol: lf',
  ])
})

test('Windows release preserves tag source bytes before checkout', () => {
  const workflow = fs.readFileSync(path.resolve(desktop, '../../.github/workflows/desktop-release.yml'), 'utf8')
  const job = workflow.split('\n  windows:\n')[1].split('\n  linux:\n')[0]
  const preserve = job.indexOf('git config --global core.autocrlf false')
  assert.ok(preserve >= 0 && preserve < job.indexOf('uses: actions/checkout@'))
})

test('committed desktop icons match the website source and generated manifest', () => {
  validateIcons()
})

test('packaging rejects stale source, changed binaries and missing icon variants', () => {
  const temp = path.resolve(desktop, '../..', 'tmp/native-icons-tests')
  fs.mkdirSync(temp, { recursive: true })
  const root = fs.mkdtempSync(path.join(temp, 'icons-'))
  const copy = path.join(root, 'desktop')
  const source = path.join(root, 'web/public/favicon.svg')
  try {
    fs.mkdirSync(path.dirname(source), { recursive: true })
    const originalSource = fs.readFileSync(path.resolve(desktop, '../web/public/favicon.svg'))
    fs.writeFileSync(source, originalSource)
    for (const file of [...iconFiles, 'build/icon-manifest.json']) {
      const output = path.join(copy, file)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.copyFileSync(path.join(desktop, file), output)
    }
    validateIcons(copy)
    fs.appendFileSync(source, '\n<!-- updated website -->')
    assert.throws(() => validateIcons(copy), /website source/)
    fs.writeFileSync(source, originalSource)
    const png = path.join(copy, 'build/icons/32x32.png')
    fs.appendFileSync(png, 'stale')
    assert.throws(() => validateIcons(copy), /32x32.png/)
    fs.copyFileSync(path.join(desktop, 'build/icons/32x32.png'), png)
    fs.unlinkSync(path.join(copy, 'build/icon.ico'))
    assert.throws(() => validateIcons(copy), /icon.ico/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
