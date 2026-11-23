import type { TurnState } from './turnController'
import { browserDiagnostics } from '../utils/browserDiagnostics'

type Message =
  | { type: 'pcm'; pcm: Int16Array; level: number; turn: TurnState; captured: number; capturedAt?: number }
  | { type: 'checkpoint'; turn: TurnState }
  | { type: 'ready' }
  | { type: 'error'; stage: 'initialization' | 'inference' }

let worker: ReturnType<typeof createWorker> | undefined

function createWorker() {
  const instance = new Worker(new URL('./voiceDsp.worker.ts', import.meta.url), { type: 'module' })
  const sessions = new Set<(reason?: string) => void>()
  let ready = false
  let idle: ReturnType<typeof setTimeout> | undefined
  const retire = (reason?: string) => {
    if (worker !== handle) return
    worker = undefined
    clearTimeout(idle)
    document.removeEventListener('visibilitychange', hide)
    window.removeEventListener('pagehide', leave)
    instance.removeEventListener('error', crash)
    instance.removeEventListener('messageerror', crash)
    instance.terminate()
    for (const close of sessions) close(reason)
  }
  const leave = () => retire()
  const hide = () => { if (document.hidden) leave() }
  const crash = () => fail(ready ? 'inference' : 'initialization')
  function fail(stage: 'initialization' | 'inference' | 'backlog') {
    browserDiagnostics.recordError(`Voice DSP: ${stage} failed`)
    retire(stage === 'initialization' ? 'speech.vadUnavailable' : 'speech.vadInterrupted')
  }
  const handle = {
    instance, fail,
    markReady() { ready = true },
    attach(close: (reason?: string) => void) {
      clearTimeout(idle)
      sessions.add(close)
      return () => {
        sessions.delete(close)
        if (sessions.size || worker !== handle) return
        // A pending initialization has no consumers. A warm model can be
        // reused for consecutive recordings in the foreground.
        if (ready) idle = setTimeout(leave, 30000)
        else leave()
      }
    },
  }
  instance.addEventListener('error', crash)
  instance.addEventListener('messageerror', crash)
  document.addEventListener('visibilitychange', hide)
  window.addEventListener('pagehide', leave)
  return handle
}

export function openVoiceDsp(rate: number,
  onChunk: (pcm: Int16Array, level: number, turn: TurnState, capturedAt?: number) => void, onError: (reason: string) => void,
  continuous = false, phoneCall = false) {
  const dsp = worker ??= createWorker()
  const { port1, port2 } = new MessageChannel()
  let queued = 0
  const runningLimit = rate * 5
  // The first model download and WASM initialization can span several seconds.
  let queueLimit = rate * 15
  let checkpoint: ((turn?: TurnState) => void) | undefined
  let closed = false
  let ready = false

  const close = (reason?: string) => {
    if (closed) return
    closed = true
    clearTimeout(startup)
    checkpoint?.()
    checkpoint = undefined
    port1.postMessage('close')
    port1.onmessage = null
    port1.close()
    detach()
    if (reason) onError(reason)
  }
  const detach = dsp.attach(close)
  const startup = setTimeout(() => dsp.fail('initialization'), 15000)
  port1.onmessage = ({ data }: MessageEvent<Message>) => {
    if (closed) return
    if (data.type === 'ready') {
      ready = true
      dsp.markReady()
      clearTimeout(startup)
    } else if (data.type === 'pcm') {
      queued -= data.captured
      if (queued <= runningLimit) queueLimit = runningLimit
      onChunk(data.pcm, data.level, data.turn, data.capturedAt)
    } else if (data.type === 'checkpoint') {
      checkpoint?.(data.turn)
      checkpoint = undefined
    } else dsp.fail(data.stage)
  }
  try {
    dsp.instance.postMessage({ port: port2, rate, continuous, phoneCall }, [port2])
  } catch {
    port2.close()
    close()
    dsp.fail('initialization')
    throw new Error('speech.vadUnavailable')
  }

  return {
    push(samples: Float32Array, capturedAt?: number) {
      if (closed) return
      queued += samples.length
      if (queued > queueLimit) { dsp.fail(ready ? 'backlog' : 'initialization'); return }
      port1.postMessage({ samples, capturedAt }, [samples.buffer])
    },
    checkpoint: () => new Promise<TurnState | undefined>(resolve => {
      if (closed) { resolve(undefined); return }
      checkpoint = resolve
      port1.postMessage('checkpoint')
    }),
    discontinuity: () => { if (!closed) port1.postMessage('discontinuity') },
    close: () => close(),
  }
}
