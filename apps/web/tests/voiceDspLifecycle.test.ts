import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { openVoiceDsp } from '../src/audio/voiceDsp'

function mockWorkers(window: ReturnType<typeof installDomEnvironment>['window']) {
  const original = globalThis.Worker
  const workers: FakeWorker[] = []
  class FakeWorker extends window.EventTarget {
    port?: MessagePort
    terminated = false
    constructor() { super(); workers.push(this) }
    postMessage({ port }: { port: MessagePort }) { this.port = port }
    terminate() { this.terminated = true; this.port?.close() }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker
  return { workers, restore: () => { globalThis.Worker = original } }
}

test('a stalled model times out and hangup releases pending DSP work', async t => {
  const { window } = installDomEnvironment()
  const { workers, restore } = mockWorkers(window)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failures: string[] = []
  const start = () => openVoiceDsp(16000, () => {}, reason => failures.push(reason))
  try {
    const stalled = start()
    const checkpoint = stalled.checkpoint()
    t.mock.timers.tick(15001)
    assert.deepEqual(failures, ['speech.vadUnavailable'])
    assert.equal(await checkpoint, undefined)
    assert.equal(workers[0].terminated, true)
    const current = start()
    current.close()
    assert.equal(workers[1].terminated, true)
    assert.equal(failures.length, 1, 'hangup during initialization does not report a failure')
  } finally {
    window.dispatchEvent(new window.Event('pagehide'))
    t.mock.timers.reset()
    restore()
    await window.happyDOM.close()
  }
})

test('failed or backgrounded model initialization cannot poison the next Worker', async () => {
  const { window } = installDomEnvironment()
  const { workers, restore } = mockWorkers(window)
  const failed = new Promise<void>(resolve => {
    openVoiceDsp(16000, () => assert.fail('unexpected audio'), () => resolve())
  })
  let second: ReturnType<typeof openVoiceDsp> | undefined
  let third: ReturnType<typeof openVoiceDsp> | undefined
  try {
    workers[0].port!.postMessage({ type: 'error', stage: 'initialization' })
    await failed
    assert.equal(workers[0].terminated, true, 'failed WASM backend state lives as long as its worker')
    second = openVoiceDsp(16000, () => {}, () => assert.fail('backgrounding is cancellation'))
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new window.Event('visibilitychange'))
    assert.equal(workers[1].terminated, true, 'hidden page releases unfinished initialization')
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new window.Event('visibilitychange'))
    assert.equal(workers.length, 2, 'returning does not create a worker by itself')
    third = openVoiceDsp(16000, () => {}, () => assert.fail('old worker failure crossed into new capture'))
    workers[1].dispatchEvent(new window.Event('error'))
    assert.equal(workers[2].terminated, false)
  } finally {
    second?.close(); third?.close()
    for (const worker of workers) worker.port?.close()
    restore()
    await window.happyDOM.close()
  }
})
