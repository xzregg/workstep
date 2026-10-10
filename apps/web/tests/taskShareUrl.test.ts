import test from 'node:test'
import assert from 'node:assert/strict'
import { taskShareUrl, canUseLocalTaskShare } from '../src/utils/taskShareUrl'

test('local task links use the current origin', () => {
  assert.equal(taskShareUrl('token', { id: 'p', type: 'local' }, 'http://localhost:8765'), 'http://localhost:8765/share/token')
})
test('remote task links use the host endpoint, preserving the deployment path', () => {
  assert.equal(taskShareUrl('token', { id: 'p', type: 'remote', endpoint: 'wss://host.example/workstep/ws/remote-project' }, 'http://localhost:8765'), 'https://host.example/workstep/share/token')
  assert.equal(taskShareUrl('token', { id: 'p', type: 'remote', endpoint: 'ws://192.168.1.2:8765/ws/remote-project' }, 'http://localhost:8765'), 'http://192.168.1.2:8765/share/token')
})

test("gateway-connected desktop keeps LAN remote task sharing", () => {
  assert.equal(canUseLocalTaskShare(true, "remote"), true)
  assert.equal(canUseLocalTaskShare(true, "local"), false)
  assert.equal(canUseLocalTaskShare(false, "local"), true)
})
