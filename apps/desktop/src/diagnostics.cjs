const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const path = require('node:path')
const { format } = require('node:util')
const { promisify } = require('node:util')
const gzip = promisify(require('node:zlib').gzip)
const LOG_MAX_BYTES = 5 * 1024 * 1024

function boundedRecord(value, maxBytes) {
  const buffer = Buffer.from(value)
  if (buffer.length <= maxBytes) return buffer
  const marker = Buffer.from('…[truncated]\n')
  // Decode and re-encode to avoid splitting a multi-byte character.
  const text = buffer.subarray(0, Math.max(0, maxBytes - marker.length)).toString('utf8').replace(/\uFFFD$/, '')
  return Buffer.concat([Buffer.from(text), marker]).subarray(0, maxBytes)
}

async function appendRotatingLog(file, value, maxBytes = LOG_MAX_BYTES, backups = 3) {
  const line = boundedRecord(value, maxBytes)
  const size = await fs.stat(file).then(stat => stat.size).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return 0
  })
  if (size + line.length > maxBytes && size) {
    if (size > maxBytes) {
      const handle = await fs.open(file, 'r+')
      try {
        const tail = Buffer.alloc(maxBytes)
        const { bytesRead } = await handle.read(tail, 0, tail.length, size - tail.length)
        await handle.write(tail, 0, bytesRead, 0)
        await handle.truncate(bytesRead)
      } finally { await handle.close() }
    }
    await fs.rm(`${file}.${backups}`, { force: true })
    for (let index = backups - 1; index >= 0; index--) {
      await fs.rename(index ? `${file}.${index}` : file, `${file}.${index + 1}`).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  await fs.appendFile(file, line, { mode: 0o600 })
}

function createDiagnostics({ directory, metadata = {}, maxBytes = LOG_MAX_BYTES, backups = 3,
  crashMaxBytes = 100 * 1024 * 1024, crashMaxFiles = 10,
  crashMaxAgeMs = 14 * 24 * 60 * 60 * 1000, crashGraceMs = 60 * 1000 }) {
  const secrets = new Set()
  let queue = Promise.resolve(), pending = 0, dropped = 0
  let maintenance = Promise.resolve()
  const logger = { directory, lastError: null }
  logger.addSecret = value => { if (typeof value === 'string' && value) secrets.add(value) }
  logger.redact = value => {
    let text = String(value)
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[redacted]')
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
      .replace(/(\b(?:authorization|api[_-]?key|password|secret|(?:[\w-]*token))\b["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"'&,}]+/gi, '$1[redacted]')
      .replace(/([?&](?:code|state|nonce|key|signature)=)[^\s&#]+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
  }
  function record(level, message) {
    return `${new Date().toISOString()} ${level} ${logger.redact(message).slice(0, 64 * 1024)}\n`
  }
  logger.write = (source, level, message) => {
    if (!['desktop', 'daemon'].includes(source)) return
    if (pending >= 1000) { dropped++; return }
    const line = record(level, message)
    pending++
    queue = queue.then(async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const file = path.join(directory, `${source}.log`)
      const notice = dropped ? record('warn', `日志队列已满，省略 ${dropped} 条记录`) : ''
      dropped = 0
      await appendRotatingLog(file, notice + line, maxBytes, backups)
    }).catch(error => { logger.lastError = error }).finally(() => { pending-- })
  }
  logger.flush = () => Promise.all([queue, maintenance])
  logger.pruneCrashes = (now = Date.now()) => {
    maintenance = maintenance.then(async () => {
      const dumps = []
      async function scan(root) {
        const stat = await fs.lstat(root).catch(error => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (!stat?.isDirectory()) return
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          const file = path.join(root, entry.name)
          if (entry.isDirectory()) await scan(file)
          else if (entry.isFile() && entry.name.endsWith('.dmp')) {
            const info = await fs.lstat(file).catch(error => {
              if (error.code !== 'ENOENT') throw error
              return null
            })
            if (info?.isFile()) dumps.push({ file, size: info.size, time: info.mtimeMs })
          }
        }
      }
      await scan(path.join(directory, 'crashes'))
      dumps.sort((a, b) => b.time - a.time)
      let retained = 0, bytes = 0
      for (const dump of dumps) {
        // Crashpad may still be writing the newest report. Recheck next pass.
        if (now - dump.time < crashGraceMs) { retained++; bytes += dump.size; continue }
        if (now - dump.time > crashMaxAgeMs || retained >= crashMaxFiles || bytes + dump.size > crashMaxBytes) {
          await fs.rm(dump.file, { force: true })
        } else { retained++; bytes += dump.size }
      }
    }).catch(error => { logger.lastError = error })
    return maintenance
  }
  // Fatal exceptions terminate Node immediately; this small, bounded final record
  // must be synchronous. Normal logging always uses the asynchronous queue.
  logger.fatal = message => {
    try {
      syncFs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const file = path.join(directory, 'fatal.log')
      const line = boundedRecord(record('fatal', message), maxBytes)
      if (syncFs.existsSync(file) && syncFs.statSync(file).size + line.length > maxBytes) {
        const size = syncFs.statSync(file).size
        if (size > maxBytes) {
          const descriptor = syncFs.openSync(file, 'r+')
          try {
            const tail = Buffer.alloc(maxBytes)
            const bytesRead = syncFs.readSync(descriptor, tail, 0, tail.length, size - tail.length)
            syncFs.writeSync(descriptor, tail, 0, bytesRead, 0)
            syncFs.ftruncateSync(descriptor, bytesRead)
          } finally { syncFs.closeSync(descriptor) }
        }
        syncFs.rmSync(`${file}.1`, { force: true })
        syncFs.renameSync(file, `${file}.1`)
      }
      syncFs.appendFileSync(file, line, { mode: 0o600 })
    } catch (error) { logger.lastError = error }
  }
  logger.exportReport = async (destination, sandboxLog) => {
    await logger.flush()
    const logs = {}
    for (const name of await fs.readdir(directory)) {
      if (!/^(?:desktop|daemon|fatal)\.log(?:\.\d+)?$/.test(name)) continue
      const file = path.join(directory, name)
      const stat = await fs.lstat(file)
      if (!stat.isFile()) continue
      const handle = await fs.open(file, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes + 128 * 1024))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length))
        logs[name] = logger.redact(buffer.subarray(0, bytesRead).toString('utf8'))
      } finally { await handle.close() }
    }
    if (typeof sandboxLog === 'string' && sandboxLog) logs['sandbox-diagnostics.log'] = logger.redact(sandboxLog).slice(-400000)
    const report = { generatedAt: new Date().toISOString(), metadata, logs,
      note: '仅包含桌面文本日志；原生崩溃转储在日志目录的 crashes/ 中。' }
    await fs.writeFile(destination, await gzip(JSON.stringify(report, null, 2)), { mode: 0o600 })
  }
  return logger
}

function installDiagnostics({ app, crashReporter, logger, processObject = process }) {
  try {
    const directory = path.join(logger.directory, 'crashes')
    syncFs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    app.setPath('crashDumps', directory)
    crashReporter.start({ productName: 'WorkStep', uploadToServer: false })
  } catch (error) { logger.write('desktop', 'error', `无法启用崩溃转储：${error.stack || error}`) }
  void logger.pruneCrashes()
  const cleanupTimer = setInterval(() => { void logger.pruneCrashes() }, 60 * 60 * 1000)
  cleanupTimer.unref()
  app.once('will-quit', () => clearInterval(cleanupTimer))
  processObject.on('uncaughtExceptionMonitor', (error, origin) => logger.fatal(`${origin}: ${error.stack || error}`))
  // Do not register unhandledRejection: Node's fatal default routes it through
  // uncaughtExceptionMonitor, retaining its original exit behavior.
  app.on('child-process-gone', (_event, details) => {
    logger.write('desktop', 'error', `child-process-gone ${JSON.stringify(details)}`)
    void logger.pruneCrashes()
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_event, details) => {
      logger.write('desktop', 'error', `render-process-gone ${JSON.stringify(details)}`)
      void logger.pruneCrashes()
    })
    contents.on('unresponsive', () => logger.write('desktop', 'warn', '页面无响应'))
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (code !== -3 && isMainFrame) logger.write('desktop', 'error', `页面加载失败 ${code}: ${description}`)
    })
  })
}

function captureConsole(logger, target = console) {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = target[level].bind(target)
    target[level] = (...args) => {
      logger.write('desktop', level, format(...args))
      original(...args)
    }
  }
}

module.exports = { createDiagnostics, installDiagnostics, captureConsole, appendRotatingLog, LOG_MAX_BYTES }
