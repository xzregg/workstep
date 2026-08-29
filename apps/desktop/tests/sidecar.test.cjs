const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildBackendArgs,
  parseReadyPort,
  protocolPath,
  resolveBackendPort,
} = require('../src/sidecar.cjs')

test('desktop requests a free port by default', () => {
  assert.equal(resolveBackendPort([], {}), 0)
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
