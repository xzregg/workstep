const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { gunzipSync } = require('node:zlib')
const { spawn } = require('node:child_process')
const { createDiagnostics, installDiagnostics, appendRotatingLog } = require('../src/diagnostics.cjs')
const { startSidecar, stopSidecar } = require('../src/sidecar.cjs')

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-diagnostics-'))
  const logger = createDiagnostics({ directory, metadata: { version: 'test' }, ...options })
  t.after(async () => { await logger.flush(); await fs.rm(directory, { recursive: true, force: true }) })
  return logger
}

test('logs persist, redact credentials and rotate with bounded retention', async t => {
  const logger = await fixture(t, { maxBytes: 512, backups: 2 })
  logger.addSecret('runtime-secret')
  for (let i = 0; i < 30; i++) logger.write('daemon', 'error', `failure ${i} token=abc runtime-secret ${'x'.repeat(60)}`)
  await logger.flush()
  const names = await fs.readdir(logger.directory)
  assert.equal(names.filter(name => name.startsWith('daemon.log')).length, 3)
  const contents = (await Promise.all(names.map(name => fs.readFile(path.join(logger.directory, name), 'utf8')))).join('')
  assert.match(contents, /failure 29/)
  assert.ok(!contents.includes('runtime-secret'))
  assert.ok(!contents.includes('token=abc'))
})

test('oversized Unicode records and fatal errors stay within byte limits across restarts', async t => {
  const logger = await fixture(t, { maxBytes: 512, backups: 2 })
  await fs.writeFile(path.join(logger.directory, 'fatal.log'), Buffer.alloc(4096))
  logger.fatal('first failure')
  assert.equal((await fs.stat(path.join(logger.directory, 'fatal.log.1'))).size, 512)
  for (let i = 0; i < 8; i++) {
    logger.write('desktop', 'error', '错'.repeat(2000))
    logger.fatal('错'.repeat(2000))
  }
  await logger.flush()
  const restarted = createDiagnostics({ directory: logger.directory, maxBytes: 512, backups: 2 })
  restarted.write('desktop', 'info', 'restart')
  await restarted.flush()
  const files = await fs.readdir(logger.directory)
  assert.equal(files.filter(name => name.startsWith('desktop.log')).length, 3)
  assert.equal(files.filter(name => name.startsWith('fatal.log')).length, 2)
  for (const file of files) assert.ok((await fs.stat(path.join(logger.directory, file))).size <= 512, file)
})

test('shared rotating writer bounds sandbox logs and old oversized files', async t => {
  const logger = await fixture(t)
  const file = path.join(logger.directory, 'sandbox.log')
  await fs.writeFile(file, 'x'.repeat(4096))
  for (let i = 0; i < 10; i++) await appendRotatingLog(file, `stage ${i} ${'x'.repeat(1000)}`, 512, 2)
  const files = await fs.readdir(logger.directory)
  assert.equal(files.length, 3)
  for (const name of files) assert.ok((await fs.stat(path.join(logger.directory, name))).size <= 512)
})

test('crash dump cleanup enforces age, count and total bytes without following symlinks', async t => {
  const now = Date.now()
  const logger = await fixture(t, { crashMaxBytes: 100, crashMaxFiles: 2, crashMaxAgeMs: 10000, crashGraceMs: 0 })
  const nested = path.join(logger.directory, 'crashes', 'reports')
  await fs.mkdir(nested, { recursive: true })
  for (const [name, age, size] of [['expired', 20000, 10], ['old', 8000, 40], ['middle', 6000, 40], ['new', 4000, 40], ['latest', 2000, 40]]) {
    const file = path.join(nested, `${name}.dmp`)
    await fs.writeFile(file, Buffer.alloc(size))
    await fs.utimes(file, new Date(now - age), new Date(now - age))
  }
  const outside = path.join(logger.directory, 'outside.dmp')
  await fs.writeFile(outside, 'keep')
  await fs.symlink(outside, path.join(nested, 'linked.dmp'))
  await fs.writeFile(path.join(nested, 'metadata'), 'keep')
  await logger.pruneCrashes(now)
  assert.deepEqual((await fs.readdir(nested)).sort(), ['latest.dmp', 'linked.dmp', 'metadata', 'new.dmp'])
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep')
})

test('crash byte budget removes excess dumps even below the count limit and protects fresh writes', async t => {
  const now = Date.now()
  const logger = await fixture(t, { crashMaxBytes: 100, crashMaxFiles: 10, crashGraceMs: 1000 })
  const root = path.join(logger.directory, 'crashes')
  await fs.mkdir(root)
  for (let i = 0; i < 3; i++) {
    const file = path.join(root, `${i}.dmp`)
    await fs.writeFile(file, Buffer.alloc(60))
    await fs.utimes(file, new Date(now - i * 2000), new Date(now - i * 2000))
  }
  await logger.pruneCrashes(now)
  assert.deepEqual(await fs.readdir(root), ['0.dmp'])
  await fs.writeFile(path.join(root, 'fresh.dmp'), Buffer.alloc(200))
  await logger.pruneCrashes(now)
  assert.ok((await fs.readdir(root)).includes('fresh.dmp'))
  await logger.pruneCrashes(now + 2000)
  assert.ok(!(await fs.readdir(root)).includes('fresh.dmp'))
})

test('diagnostic export contains only allowlisted logs and metadata', async t => {
  const logger = await fixture(t)
  logger.write('desktop', 'info', 'started')
  await fs.writeFile(path.join(logger.directory, 'credentials.json'), 'private')
  const target = path.join(logger.directory, 'report.json.gz')
  await logger.exportReport(target, 'sandbox token=private-token')
  const report = JSON.parse(gunzipSync(await fs.readFile(target)))
  assert.equal(report.metadata.version, 'test')
  assert.match(report.logs['desktop.log'], /started/)
  assert.match(report.logs['sandbox-diagnostics.log'], /\[redacted\]/)
  assert.ok(!JSON.stringify(report).includes('private'))
})

test('disk errors do not reject logging or break the application', async t => {
  const logger = await fixture(t)
  await fs.rmdir(logger.directory)
  await fs.writeFile(logger.directory, 'not a directory')
  logger.write('desktop', 'error', 'failure')
  await logger.flush()
  assert.ok(logger.lastError)
})

test('Electron crashes and fatal JS errors are captured without swallowing fatal exceptions', async t => {
  const logger = await fixture(t)
  const app = new EventEmitter(), proc = new EventEmitter(), contents = new EventEmitter()
  app.setPath = (name, value) => { app[name] = value }
  let options
  installDiagnostics({ app, processObject: proc, crashReporter: { start: value => { options = value } }, logger })
  assert.equal(options.uploadToServer, false)
  assert.equal(proc.listenerCount('uncaughtException'), 0)
  app.emit('web-contents-created', {}, contents)
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
  proc.emit('uncaughtExceptionMonitor', new Error('fatal test'), 'uncaughtException')
  await logger.flush()
  assert.match(await fs.readFile(path.join(logger.directory, 'desktop.log'), 'utf8'), /render-process-gone.*crashed/)
  assert.match(await fs.readFile(path.join(logger.directory, 'fatal.log'), 'utf8'), /fatal test/)
})

test('real sidecar output and post-ready exit are logged', async t => {
  const logger = await fixture(t)
  const result = await startSidecar({ executable: process.execPath,
    args: ['-e', 'console.log("PORT:43123"); console.error("backend failure"); setTimeout(() => process.exit(2), 100)', '--'],
    port: 0, logger })
  await new Promise(resolve => result.child.once('exit', resolve))
  await logger.flush()
  const output = await fs.readFile(path.join(logger.directory, 'daemon.log'), 'utf8')
  assert.match(output, /backend failure/)
  assert.match(output, /"code":2/)
  await stopSidecar(result.child)
})

test('slow log writes leave the event loop responsive', async t => {
  const logger = await fixture(t)
  const original = fs.appendFile
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  fs.appendFile = async (...args) => {
    entered()
    await new Promise(resolve => { release = resolve })
    return original(...args)
  }
  try {
    logger.write('desktop', 'info', 'slow disk')
    await started
    let completed = false
    logger.flush().then(() => { completed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(completed, false, 'timer responds while disk write remains blocked')
  } finally {
    release?.()
    await logger.flush()
    fs.appendFile = original
  }
})

for (const failure of ['throw new Error("fatal child")', 'Promise.reject(new Error("fatal child"))']) {
  test(`real fatal exception persists before exit: ${failure}`, async t => {
    const logger = await fixture(t)
    const script = `const { createDiagnostics, installDiagnostics } = require(${JSON.stringify(require.resolve('../src/diagnostics.cjs'))});
      const app = new (require('node:events').EventEmitter)(); app.setPath = () => {};
      installDiagnostics({ app, crashReporter: { start() {} }, logger: createDiagnostics({ directory: ${JSON.stringify(logger.directory)} }) });
      ${failure};`
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    const code = await new Promise(resolve => child.once('exit', resolve))
    assert.notEqual(code, 0)
    assert.match(await fs.readFile(path.join(logger.directory, 'fatal.log'), 'utf8'), /fatal child/)
  })
}
