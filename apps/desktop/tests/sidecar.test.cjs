const assert = require('node:assert/strict')
const test = require('node:test')

const {
  backendLaunch,
  buildBackendArgs,
  parseReadyPort,
  protocolPath,
  resolveBackendPort,
} = require('../src/sidecar.cjs')
const {
  isAllowedExternalUrl,
  isGatewayDesktopLoginUrl,
  isTrustedNavigation,
  projectsHaveActiveWork,
  sessionsHaveActiveWork,
  primaryNetworkIPv4,
} = require('../src/security.cjs')

test('packaged desktop launches the bundled writable Python runtime', () => {
  assert.deepEqual(backendLaunch('/Applications/WorkStep/resources', 'darwin'), {
    executable: '/Applications/WorkStep/resources/backend/python/bin/python3',
    args: ['/Applications/WorkStep/resources/backend/app/main.py'],
  })
  assert.deepEqual(backendLaunch('C:\\WorkStep\\resources', 'win32'), {
    executable: 'C:\\WorkStep\\resources\\backend\\python\\python.exe',
    args: ['C:\\WorkStep\\resources\\backend\\app\\main.py'],
  })
})

test('desktop prefers the fixed port by default', () => {
  assert.equal(resolveBackendPort([], {}), 8766)
  assert.deepEqual(buildBackendArgs(0), ['--port', '0'])
})

test('desktop port can be changed by command line or environment', () => {
  assert.equal(resolveBackendPort(['--backend-port=43123'], {}), 43123)
  assert.equal(resolveBackendPort([], { WORKSTEP_DESKTOP_PORT: '43124' }), 43124)
  assert.equal(resolveBackendPort(['--port', '43126'], {}), 43126)
  assert.equal(
    resolveBackendPort(
      ['--backend-port', '43125'],
      { WORKSTEP_DESKTOP_PORT: '43124' },
    ),
    43125,
  )
})

test('invalid configured ports are rejected before spawning the backend', () => {
  for (const value of ['-1', '65536', 'abc']) {
    assert.throws(
      () => resolveBackendPort([`--backend-port=${value}`], {}),
      /backend port/i,
    )
  }
})

test('only the backend ready protocol yields a usable port', () => {
  assert.equal(parseReadyPort('PORT:43123\n'), 43123)
  assert.equal(parseReadyPort('INFO starting\nPORT:43124\n'), 43124)
  assert.equal(parseReadyPort('PORT:0\n'), null)
  assert.equal(parseReadyPort('running on 43123\n'), null)
})

test('supported deep links are forwarded without accepting arbitrary URLs', () => {
  assert.equal(protocolPath('workstep://open'), '/')
  assert.equal(
    protocolPath('workstep://remote-project/v1/example-token'),
    '/?workstep_url=workstep%3A%2F%2Fremote-project%2Fv1%2Fexample-token',
  )
  assert.throws(() => protocolPath('https://example.com'), /unsupported/i)
  assert.throws(() => protocolPath('workstep://unknown'), /unsupported/i)
})

test('desktop navigation remains on the authenticated local origin', () => {
  const rootUrl = 'http://127.0.0.1:43123'

  assert.equal(isTrustedNavigation(`${rootUrl}/tasks/1`, rootUrl), true)
  assert.equal(isTrustedNavigation('http://127.0.0.1:43124/', rootUrl), false)
  assert.equal(isTrustedNavigation('https://example.com/', rootUrl), false)
  assert.equal(isTrustedNavigation('not a url', rootUrl), false)
})

test('only ordinary web links may be delegated to the system browser', () => {
  assert.equal(isAllowedExternalUrl('https://example.com/docs'), true)
  assert.equal(isAllowedExternalUrl('http://example.com/docs'), true)
  assert.equal(isAllowedExternalUrl('file:///tmp/private'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
  assert.equal(isAllowedExternalUrl('workstep://open'), false)
})

test('only a complete Gateway desktop login URL opens in the embedded auth window', () => {
  const query = new URLSearchParams({
    gateway_id: 'gateway-test', app_instance_id: 'app-test',
    state: 's'.repeat(32), nonce: 'n'.repeat(32), code_challenge: 'A'.repeat(43),
  })
  assert.equal(isGatewayDesktopLoginUrl(`http://192.168.52.156:8700/desktop/login?${query}`), true)
  assert.equal(isGatewayDesktopLoginUrl(`https://gateway.example.com/desktop/login?${query}`), true)
  query.set('redirect_uri', 'http://127.0.0.1:8766/api/gateway-platform/callback')
  assert.equal(isGatewayDesktopLoginUrl(`https://gateway.example.com/desktop/login?${query}`), true)
  query.set('redirect_uri', 'https://evil.example.com/api/gateway-platform/callback')
  assert.equal(isGatewayDesktopLoginUrl(`https://gateway.example.com/desktop/login?${query}`), false)
  query.delete('redirect_uri')
  assert.equal(isGatewayDesktopLoginUrl(`http://8.8.8.8:8700/desktop/login?${query}`), false)
  assert.equal(isGatewayDesktopLoginUrl(`https://gateway.example.com/admin?${query}`), false)
  query.set('extra', 'value')
  assert.equal(isGatewayDesktopLoginUrl(`https://gateway.example.com/desktop/login?${query}`), false)
})

test('updates are blocked while any project has active work', () => {
  assert.equal(projectsHaveActiveWork({ projects: [] }), false)
  assert.equal(projectsHaveActiveWork({
    projects: [{ id: 'idle', has_running_tasks: false }],
  }), false)
  assert.equal(projectsHaveActiveWork({
    projects: [
      { id: 'idle', has_running_tasks: false },
      { id: 'busy', has_running_tasks: true },
    ],
  }), true)
  assert.equal(projectsHaveActiveWork({
    projects: [{ id: 'busy', workflows: [{ running: true }] }],
  }), true)
  assert.equal(projectsHaveActiveWork(null), true)
})

test('updates are blocked while any chat session has active work', () => {
  assert.equal(sessionsHaveActiveWork({ sessions: [] }), false)
  assert.equal(sessionsHaveActiveWork({ sessions: [{ running: false }] }), false)
  assert.equal(sessionsHaveActiveWork({ sessions: [{ running: true }] }), true)
  assert.equal(sessionsHaveActiveWork(null), true)
})

test('desktop remote access advertises a LAN address instead of a VM address', () => {
  assert.equal(primaryNetworkIPv4({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    utun5: [{ family: 'IPv4', address: '198.18.0.1', internal: false }],
    en0: [{ family: 'IPv4', address: '192.168.50.24', internal: false }],
  }), '192.168.50.24')
})
