import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { buildWebRtcPairingLink, consumeWebRtcPairingLink, loadSessionPairKey, saveSessionPairKey, validWebRtcPairKey } from '../src/webrtc/pairingLink'

test('pairing link uses a fragment, strips credentials from history and stays scoped to its device', async () => {
  const { window } = installDomEnvironment()
  const key = 'A1_-'.repeat(8)
  try {
    const link = buildWebRtcPairingLink('https://signal.example.com/p2p/device-1/', key)
    assert.equal(link, `https://signal.example.com/p2p/device-1/#pair_key=${key}`)
    assert.equal(new URL(link).search, '')
    window.happyDOM.setURL(link)
    consumeWebRtcPairingLink()
    assert.equal(window.location.hash, '')
    assert.equal(loadSessionPairKey('device-1'), key)
    assert.equal(loadSessionPairKey('other-device'), '')
    saveSessionPairKey('device-1', '')
    assert.equal(loadSessionPairKey('device-1'), '')
    window.happyDOM.setURL('https://signal.example.com/p2p/device-1/#pair_key=short')
    consumeWebRtcPairingLink()
    assert.equal(window.location.hash, '')
    assert.equal(loadSessionPairKey('device-1'), '')
  } finally { await window.happyDOM.close() }
})

test('pairing key boundaries and link destinations reject invalid values', () => {
  for (const length of [24, 32, 128]) assert.equal(validWebRtcPairKey('a'.repeat(length)), true)
  for (const value of ['a'.repeat(23), 'a'.repeat(129), 'a'.repeat(24) + ' ', '密'.repeat(32)]) {
    assert.equal(validWebRtcPairKey(value), false)
    assert.equal(buildWebRtcPairingLink('https://signal.example.com/p2p/d/', value), '')
  }
  assert.equal(buildWebRtcPairingLink('https://signal.example.com/devices', 'a'.repeat(32)), '')
})

test('verified QR keys remain available for reconnection when browser storage is blocked', async () => {
  const { window } = installDomEnvironment()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  try {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Storage blocked') } })
    const key = 'a'.repeat(32)
    saveSessionPairKey('blocked-storage-device', key)
    assert.equal(loadSessionPairKey('blocked-storage-device'), key)
    saveSessionPairKey('blocked-storage-device', '')
    assert.equal(loadSessionPairKey('blocked-storage-device'), '')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
    await window.happyDOM.close()
  }
})
