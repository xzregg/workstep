import type { TurnState } from './turnController'

type Message =
  | { type: 'pcm'; pcm: Int16Array; level: number; turn: TurnState; captured: number }
  | { type: 'checkpoint'; turn: TurnState }
  | { type: 'error' }

let worker: Worker | undefined

export function openVoiceDsp(rate: number,
  onChunk: (pcm: Int16Array, level: number, turn: TurnState) => void, onError: () => void) {
  const dsp = worker ??= new Worker(new URL('./voiceDsp.worker.ts', import.meta.url), { type: 'module' })
  const { port1, port2 } = new MessageChannel()
  let queued = 0
  let checkpoint: ((turn: TurnState) => void) | undefined
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    dsp.removeEventListener('error', crash)
    port1.postMessage('close')
    port1.close()
  }
  const crash = () => {
    if (worker === dsp) { worker = undefined; dsp.terminate() }
    close()
    onError()
  }
  dsp.addEventListener('error', crash)
  port1.onmessage = ({ data }: MessageEvent<Message>) => {
    if (closed) return
    if (data.type === 'pcm') {
      queued -= data.captured
      onChunk(data.pcm, data.level, data.turn)
    } else if (data.type === 'checkpoint') {
      checkpoint?.(data.turn)
      checkpoint = undefined
    } else {
      close()
      onError()
    }
  }
  dsp.postMessage({ port: port2, rate }, [port2])

  return {
    push(samples: Float32Array) {
      queued += samples.length
      if (queued > rate * 5) { close(); onError(); return }
      port1.postMessage(samples, [samples.buffer])
    },
    checkpoint: () => new Promise<TurnState>(resolve => {
      checkpoint = resolve
      port1.postMessage('checkpoint')
    }),
    discontinuity: () => port1.postMessage('discontinuity'),
    close,
  }
}
