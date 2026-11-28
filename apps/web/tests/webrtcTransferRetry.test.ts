import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { retryWebRtcTransfer } from '../src/webrtc/retryTransfer'
import { useWebRtcConnectionStore } from '../src/webrtc/webrtcConnectionStore'
import { fsApi } from '../src/api/client'
import { skinsApi } from '../src/api/skins'
import { languagesApi } from '../src/api/languages'
import { downloadWebRtcBlob } from '../src/webrtc/downloadFile'

test('closed transfer waits for recovery and retries body consumption with a bounded attempt count', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://example.com/p2p/device/')
  let reconnects = 0
  let attempts = 0
  let recovered = false
  const reconnect = () => {
    reconnects++
    recovered = false
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: true })
    setTimeout(() => {
      recovered = true
      useWebRtcConnectionStore.setState({ connected: true, reconnecting: false })
    }, 10)
  }
  window.addEventListener('workstep:webrtc-reconnect', reconnect)
  try {
    const value = await retryWebRtcTransfer(async () => {
      attempts++
      if (attempts === 1) return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('WebRTC DataChannel closed')) },
      })).text()
      assert.equal(recovered, true)
      return 'downloaded'
    })
    assert.equal(value, 'downloaded')
    assert.equal(attempts, 2)
    assert.equal(reconnects, 1)
    attempts = 0
    await assert.rejects(retryWebRtcTransfer(async () => {
      attempts++
      throw new TypeError('WebRTC DataChannel closed')
    }), /DataChannel closed/)
    assert.equal(attempts, 3)
    attempts = 0
    await assert.rejects(retryWebRtcTransfer(async () => {
      attempts++
      throw new Error('HTTP 403')
    }), /403/)
    assert.equal(attempts, 1)
  } finally {
    window.removeEventListener('workstep:webrtc-reconnect', reconnect)
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: false })
    await window.happyDOM.close()
  }
})

test('image upload retries a lost response with the same upload identifier', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://example.com/p2p/device/')
  const originalFetch = globalThis.fetch
  const originalReader = globalThis.FileReader
  globalThis.FileReader = window.FileReader as unknown as typeof FileReader
  const requests: string[] = []
  const reconnect = () => {
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: true })
    queueMicrotask(() => useWebRtcConnectionStore.setState({ connected: true, reconnecting: false }))
  }
  window.addEventListener('workstep:webrtc-reconnect', reconnect)
  globalThis.fetch = async (_input, init) => {
    requests.push(String(init?.body))
    if (requests.length === 1) return new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('WebRTC DataChannel closed')) },
    }))
    return Response.json({ url: '.workstep/uploads/image.png', filename: 'image.png', size: 3 })
  }
  try {
    const result = await fsApi.uploadImage(new window.File(['abc'], 'image.png', { type: 'image/png' }) as unknown as File, 'p1')
    assert.equal(result.filename, 'image.png')
    assert.equal(requests.length, 2)
    assert.equal(requests[0], requests[1])
    assert.match(JSON.parse(requests[0]).request_id, /^[0-9a-f-]{36}$/)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.FileReader = originalReader
    window.removeEventListener('workstep:webrtc-reconnect', reconnect)
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: false })
    await window.happyDOM.close()
  }
})


test('skin and language exports retry interrupted bodies and save ZIP bytes through Android', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://example.com/p2p/device/')
  const previousFetch = globalThis.fetch
  const reconnect = () => {
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: true })
    queueMicrotask(() => useWebRtcConnectionStore.setState({ connected: true, reconnecting: false }))
  }
  window.addEventListener('workstep:webrtc-reconnect', reconnect)
  const commands: Array<{type: string; filename?: string; data?: string}> = []
  const native = { onmessage: null as ((event: { data: string }) => void) | null, postMessage(message: string) {
    commands.push(JSON.parse(message))
    queueMicrotask(() => native.onmessage?.({data:'ok'}))
  } }
  window.WorkStepP2pDownload = native
  try {
    for (const api of [skinsApi, languagesApi]) {
      let attempts = 0
      globalThis.fetch = async () => {
        attempts++
        if (attempts === 1) return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError('WebRTC DataChannel closed')) },
        }))
        return new Response('PK-test-zip', {headers:{'Content-Type':'application/zip'}})
      }
      const result = await api.export('custom')
      assert.equal(attempts, 2)
      await downloadWebRtcBlob(result, 'custom.zip')
    }
    assert.equal(commands.filter(command => command.type === 'finish').length, 2)
    assert.equal(commands.find(command => command.type === 'start')?.filename, 'custom.zip')
    for (const command of commands.filter(command => command.type === 'chunk')) {
      assert.equal(atob(command.data!), 'PK-test-zip')
    }
  } finally {
    globalThis.fetch = previousFetch
    window.removeEventListener('workstep:webrtc-reconnect', reconnect)
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: false })
    await window.happyDOM.close()
  }
})
