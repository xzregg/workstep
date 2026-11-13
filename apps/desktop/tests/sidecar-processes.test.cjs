const assert = require('node:assert/strict')
const test = require('node:test')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { startSidecar, stopSidecar } = require('../src/sidecar.cjs')

const execute = promisify(execFile)
async function alive(pid) {
  try {
    const { stdout } = await execute('ps', ['-o', 'stat=', '-p', String(pid)])
    return stdout.trim() !== '' && !stdout.trim().startsWith('Z')
  } catch { return false }
}

for (const mode of ['forced-stop', 'unexpected-exit']) {
  test(`sidecar ${mode} reaps its descendants and preserves unrelated processes`, {
    skip: process.platform === 'win32',
  }, async () => {
    const root = path.resolve(__dirname, '../../../tmp/process-lifecycle-audit')
    fs.mkdirSync(root, { recursive: true })
    const dir = fs.mkdtempSync(path.join(root, 'sidecar-'))
    const pidFile = path.join(dir, 'child.pid')
    const childSource = 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      const p=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:['ignore','pipe','ignore']});
      p.stdout.once('data',()=>{fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));console.log('PORT:12345')});
      setInterval(()=>{},1000);`
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    let child, descendant
    try {
      ({ child } = await startSidecar({ executable: process.execPath, args: ['-e', source, '--'], port: 0 }))
      descendant = Number(fs.readFileSync(pidFile, 'utf8'))
      assert.equal(await alive(descendant), true)
      if (mode === 'unexpected-exit') {
        child.kill('SIGKILL')
        await new Promise(resolve => child.once('exit', resolve))
      }
      await stopSidecar(child, 30)
      for (let i = 0; i < 100 && await alive(descendant); i++) await delay(10)
      assert.equal(await alive(descendant), false, 'daemon descendant survived sidecar shutdown')
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'stop must await root exit')
      assert.equal(await alive(sentinel.pid), true, 'shutdown killed an unrelated process')
    } finally {
      if (descendant && await alive(descendant)) process.kill(descendant, 'SIGKILL')
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      sentinel.kill('SIGKILL')
      await new Promise(resolve => sentinel.once('exit', resolve))
    }
  })
}
