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

function startSidecar({ executable, args = [], port, env = process.env, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, ...buildBackendArgs(port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    let stderr = ''
    const timeout = setTimeout(() => {
      finish(new Error(`Backend did not become ready within ${timeoutMs}ms`))
      child.kill()
    }, timeoutMs)

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(result)
    }

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const readyPort = parseReadyPort(line)
      if (readyPort !== null) finish(null, { child, port: readyPort })
    })
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      stderr = `${stderr}${line}\n`.slice(-4000)
    })
    child.once('error', finish)
    child.once('exit', (code, signal) => {
      finish(new Error(
        `Backend exited before ready (code=${code}, signal=${signal})${stderr ? `\n${stderr}` : ''}`,
      ))
    })
  })
}

async function stopSidecar(child, graceMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, graceMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill()
  })
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
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
