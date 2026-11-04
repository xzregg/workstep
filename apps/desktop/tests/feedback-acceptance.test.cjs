const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

test('real Electron feedback copies text, requests screenshot consent and previews only the workspace', {
  skip: process.env.WORKSTEP_FEEDBACK_ACCEPTANCE !== '1', timeout: 30000,
}, async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Never let require('electron') implicitly download a runtime during tests.
  const packageDirectory = path.dirname(require.resolve('electron/package.json'))
  const executable = path.join(packageDirectory, 'dist', fs.readFileSync(path.join(packageDirectory, 'path.txt'), 'utf8').trim())
  assert.ok(fs.existsSync(executable), 'Install the Electron runtime before running this offline acceptance test')
  const child = spawn(executable, [path.join(__dirname, 'fixtures/feedback-acceptance.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, 0, output)
    assert.match(output, /FEEDBACK_ACCEPTANCE_OK/)
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL') }
})
