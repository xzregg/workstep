import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm'
import wasmModuleUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url&no-inline'
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url&no-inline'
import modelUrl from './silero-v5.1.2/silero_vad.onnx?url&no-inline'
import { VoiceResampler } from './voiceResampler'
import { TurnController } from './turnController'

env.wasm.numThreads = 1
env.wasm.wasmPaths = {
  mjs: new URL(wasmModuleUrl, self.location.href).href,
  wasm: new URL(wasmUrl, self.location.href).href,
}
let sharedSession: Promise<InferenceSession> | undefined

function getSession() {
  return sharedSession ??= InferenceSession.create(modelUrl, { executionProviders: ['wasm'] }).catch(error => {
    sharedSession = undefined
    throw error
  })
}

function connect(port: MessagePort, rate: number, continuous: boolean, phoneCall: boolean) {
  let resampler = new VoiceResampler(rate)
  const input = new Float32Array(64 + 512)
  let turn = new TurnController(phoneCall)
  let state: Tensor = new Tensor('float32', new Float32Array(256), [2, 1, 128])
  const sr = new Tensor('int64', BigInt64Array.of(16000n), [])
  let used = 0
  let end = 0
  let closed = false
  let checkpointPending = false

  function confirmCheckpoint() {
    checkpointPending = false
    port.postMessage({ type: 'checkpoint', turn: turn.snapshot() })
  }

  function fail(stage: 'initialization' | 'inference') {
    if (closed) return
    port.postMessage({ type: 'error', stage })
    closed = true
    port.close()
  }

  const session = getSession()
  let pending = session.then(() => {
    if (!closed) port.postMessage({ type: 'ready' })
  }, () => fail('initialization'))
  port.onmessage = ({ data }: MessageEvent<{ samples: Float32Array; capturedAt?: number } | 'checkpoint' | 'discontinuity' | 'close'>) => {
    if (data === 'close') { closed = true; port.close(); return }
    pending = pending.then(async () => {
      if (closed) return
      if (data === 'discontinuity') {
        resampler = new VoiceResampler(rate)
        input.fill(0)
        state = new Tensor('float32', new Float32Array(256), [2, 1, 128])
        used = 0
        turn.discontinuity(end)
        return
      }
      if (data === 'checkpoint') {
        // A flush can end in the middle of a Silero frame. Wait for the next
        // real samples to cover that watermark without padding recurrent input.
        if (used) checkpointPending = true
        else confirmCheckpoint()
        return
      }
      const { samples, capturedAt } = data
      const pcm = resampler.push(samples)
      let completedFrame = false
      for (const sample of pcm) {
        input[64 + used++] = sample / 32768
        end++
        if (used !== 512) continue
        const { output, stateN } = await (await session).run({ input: new Tensor('float32', input, [1, 576]), state, sr })
        turn.frame({ end, probability: Number(output.data[0]) })
        state = stateN
        input.copyWithin(0, 512)
        used = 0
        completedFrame = true
        if (closed) return
      }
      const level = Math.min(1, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) * 5)
      port.postMessage({ type: 'pcm', pcm, level, turn: turn.snapshot(), captured: samples.length, capturedAt }, [pcm.buffer])
      if (checkpointPending && completedFrame) confirmCheckpoint()
      // Keep Silero's acoustic context while opening a fresh utterance.
      if (continuous && turn.canCommit) turn = new TurnController(phoneCall)
    }).catch(() => fail('inference'))
  }
}

self.onmessage = ({ data }: MessageEvent<{ port: MessagePort; rate: number; continuous: boolean; phoneCall: boolean }>) =>
  connect(data.port, data.rate, data.continuous, data.phoneCall)
