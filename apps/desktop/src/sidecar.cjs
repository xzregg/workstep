const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const READY_PATTERN = /^PORT:(\d{1,5})$/m

function parsePort(value) {
  if (!/^\d+$/.test(value ?? '')) {
    throw new Error(`Invalid backend port: ${value}`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid backend port: ${value}`)
  }
  return port
}

function resolveBackendPort(argv = process.argv.slice(1), env = process.env) {
  let configured
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('--backend-port=') || argument.startsWith('--port=')) {
      configured = argument.slice(argument.indexOf('=') + 1)
      break
    }
    if (argument === '--backend-port' || argument === '--port') {
      configured = argv[index + 1]
      break
    }
  }
  return parsePort(configured ?? env.WORKSTEP_DESKTOP_PORT ?? '8766')
}

function buildBackendArgs(port) {
  return ['--port', String(port)]
}

function parseReadyPort(output) {
  const match = output.match(READY_PATTERN)
  if (!match) return null
  const port = Number(match[1])
  return port >= 1 && port <= 65535 ? port : null
}

function protocolPath(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Unsupported WorkStep URL: ${value}`)
  }
  if (url.protocol !== 'workstep:') {
    throw new Error(`Unsupported WorkStep URL: ${value}`)
  }
  if (url.hostname === 'open' && (url.pathname === '' || url.pathname === '/')) {
    return '/'
  }
  if (url.hostname === 'remote-project' && url.pathname.startsWith('/v1/')) {
    return `/?workstep_url=${encodeURIComponent(value)}`
  }
  throw new Error(`Unsupported WorkStep URL: ${value}`)
}

function backendLaunch(resourcesPath, platform = process.platform) {
  const pathImpl = platform === 'win32' ? path.win32 : path
  const backendDir = pathImpl.join(resourcesPath, 'backend')
  return {
    executable: platform === 'win32'
      ? pathImpl.join(backendDir, 'python', 'python.exe')
      : pathImpl.join(backendDir, 'python', 'bin', 'python3'),
    args: [pathImpl.join(backendDir, 'app', 'main.py')],
  }
}

function startSidecar({ executable, args = [], port, env = process.env, timeoutMs = 120_000, logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, ...buildBackendArgs(port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A dedicated group lets forced shutdown include SDK/MCP/voice children
      // without ever signalling Electron or another daemon instance.
      detached: process.platform !== 'win32',
    })
    child.workstepProcessGroup = process.platform === 'win32' ? null : child.pid
    child.workstepStartedAt = new Date().toISOString()
    let settled = false
    let recentOutput = ''
    logger?.write('daemon', 'info', '后台进程已启动')
    const timeout = setTimeout(() => {
      finish(startupError(`Backend did not become ready within ${timeoutMs}ms`))
      void stopSidecar(child).catch(error => logger?.write('daemon', 'error', String(error)))
    }, timeoutMs)

    function startupError(message) {
      const detail = recentOutput ? `\n最近后台输出：\n${recentOutput}` : '\n后台尚未输出启动日志'
      const text = `${message}${detail}`
      return new Error(logger?.redact ? logger.redact(text) : text)
    }

    function record(level, line) {
      logger?.write('daemon', level, line)
      if (!settled) {
        // Redact before truncating, so a cut credential cannot evade matching.
        const safeLine = logger?.redact ? logger.redact(line) : line
        recentOutput = `${recentOutput}${safeLine}\n`.slice(-4000)
      }
    }

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(result)
    }

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      record('info', line)
      const readyPort = parseReadyPort(line)
      if (readyPort !== null) finish(null, { child, port: readyPort })
    })
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      const progress = /^STARTUP .+ (?:start|complete elapsed_ms=\d+)$/.test(line)
      record(progress ? 'info' : 'error', line)
    })
    child.once('error', finish)
    child.once('exit', (code, signal) => {
      logger?.write('daemon', child.workstepStopping ? 'info' : 'error',
        `后台进程退出 ${JSON.stringify({ code, signal, expected: Boolean(child.workstepStopping) })}`)
      void stopSidecar(child).catch(error => logger?.write('daemon', 'error', String(error)))
    })
    // close follows pipe drainage, so an early exit retains its final output.
    child.once('close', (code, signal) => {
      finish(startupError(`Backend exited before ready (code=${code}, signal=${signal})`))
    })
  })
}

function running(child) {
  return child.exitCode === null && child.signalCode === null
}

function signalOwnedGroup(child, signal) {
  const group = child.workstepProcessGroup
  if (!Number.isSafeInteger(group) || group <= 0 || group === process.pid) return false
  try {
    process.kill(-group, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

function waitForExit(child, timeoutMs, signal) {
  if (!running(child)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timeout); child.removeListener('exit', finish); resolve() }
    const timeout = setTimeout(finish, timeoutMs)
    child.once('exit', finish)
    try { signal?.() } catch (error) {
      clearTimeout(timeout)
      child.removeListener('exit', finish)
      reject(error)
    }
  })
}

function stopSidecar(child, graceMs = 10_000) {
  if (!child) return Promise.resolve()
  if (child.workstepStopPromise) return child.workstepStopPromise
  child.workstepStopping = true
  child.workstepStopPromise = (async () => {
    if (process.platform === 'win32' && running(child)) {
      // Windows has no POSIX process groups; terminate the owned tree while
      // its root still exists so taskkill can enumerate descendants.
      await new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', reject)
        killer.once('exit', code => code === 0 || !running(child) ? resolve() : reject(new Error('Failed to terminate the background process tree')))
      })
    } else if (running(child)) {
      await waitForExit(child, graceMs, () => child.kill())
      if (running(child)) {
        await waitForExit(child, 2000, () => {
          if (!signalOwnedGroup(child, 'SIGKILL')) child.kill('SIGKILL')
        })
      }
    }
    if (process.platform !== 'win32' && signalOwnedGroup(child, 'SIGTERM')) {
      await new Promise(resolve => setTimeout(resolve, Math.min(graceMs, 250)))
      signalOwnedGroup(child, 'SIGKILL')
    }
    await waitForExit(child, 2000)
    if (running(child)) throw new Error('Background process failed to exit')
  })()
  return child.workstepStopPromise
}

module.exports = {
  backendLaunch,
  buildBackendArgs,
  parseReadyPort,
  protocolPath,
  resolveBackendPort,
  startSidecar,
  stopSidecar,
}
