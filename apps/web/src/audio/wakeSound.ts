import { sharedOutputContext } from '../utils/speechOutput'

const url = new URL('./wake-chime.wav?no-inline', import.meta.url).href
const buffers = new WeakMap<AudioContext, Promise<AudioBuffer>>()
const startupTimeout = 2300
const completionTimeout = 3500
export type WakeMediaResult = 'finished' | 'unavailable' | 'interrupted'

export const isAndroidWakeClient = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  || typeof window !== 'undefined' && !!window.WorkStepAndroid

declare global {
  interface Window {
    WorkStepWakeChime?: NonNullable<Window['WorkStepSpeech']>
    WorkStepWakeGreeting?: NonNullable<Window['WorkStepSpeech']>
  }
}

let chimeSequence = 0
let stopNativeChime: (() => void) | undefined
export function playNativeWakeMedia(bridge: NonNullable<Window['WorkStepSpeech']>,
  request: { type: 'wake-chime' } | { type: 'wake-greeting'; chunks: string[]; sampleRate: number; volume: number; rate: number },
  signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve<WakeMediaResult>('unavailable')
  stopNativeChime?.()
  return new Promise<WakeMediaResult>(resolve => {
    const id = `chime-${++chimeSequence}`
    let started = false
    const finish = (result: WakeMediaResult) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      bridge.onmessage = null
      stopNativeChime = undefined
      resolve(result)
    }
    const stop = () => {
      finish(started ? 'interrupted' : 'unavailable')
      try { bridge.postMessage(JSON.stringify({ type: 'stop', id })) } catch { /* Bridge is gone. */ }
    }
    let timer = setTimeout(stop, startupTimeout)
    stopNativeChime = stop
    signal.addEventListener('abort', stop, { once: true })
    bridge.onmessage = event => {
      try {
        const result = JSON.parse(event.data)
        if (result.id !== id) return
        if (result.status === 'started' && !started) {
          started = true
          clearTimeout(timer)
          timer = setTimeout(stop, request.type === 'wake-greeting' ? 30000 : completionTimeout)
        } else if (result.status === 'done') {
          finish('finished')
        } else if (result.status === 'error') {
          finish(started ? 'interrupted' : 'unavailable')
        }
      } catch { /* Ignore malformed responses. */ }
    }
    try { bridge.postMessage(JSON.stringify({ ...request, id })) } catch { stop() }
  })
}

function chimeBuffer(context: AudioContext) {
  let buffer = buffers.get(context)
  if (!buffer) {
    buffer = fetch(url).then(response => {
      if (!response.ok) throw new Error('Wake sound could not load')
      return response.arrayBuffer()
    }).then(bytes => context.decodeAudioData(bytes))
    buffers.set(context, buffer)
    void buffer.catch(() => buffers.delete(context))
  }
  return buffer
}

export function prepareWakeSound() {
  if (typeof Audio === 'undefined') return null
  const audio = new Audio(url)
  audio.preload = 'auto'
  if (isAndroidWakeClient() && typeof AudioContext !== 'undefined') {
    try { void chimeBuffer(sharedOutputContext()) } catch { /* Media element fallback remains available. */ }
  }
  return audio
}

function playAndroidChime(signal: AbortSignal) {
  return new Promise<WakeMediaResult>(resolve => {
    let source: AudioBufferSourceNode | undefined
    let started = false
    let finished = false
    const finish = (result: WakeMediaResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (source) {
        source.onended = null
        if (started && result !== 'finished') source.stop()
        source.disconnect()
      }
      resolve(result)
    }
    const abort = () => finish(started ? 'interrupted' : 'unavailable')
    let timer = setTimeout(abort, startupTimeout)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const context = sharedOutputContext()
      void Promise.all([context.resume(), chimeBuffer(context)]).then(([, buffer]) => {
        if (finished) return
        source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => finish('finished')
        source.start()
        started = true
        clearTimeout(timer)
        timer = setTimeout(abort, completionTimeout)
      }).catch(abort)
    } catch { abort() }
  })
}

export async function playWakeSound(audio: HTMLAudioElement | null, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const bridge = typeof window !== 'undefined' ? window.WorkStepWakeChime : undefined
  if (bridge) {
    const result = await playNativeWakeMedia(bridge, { type: 'wake-chime' }, signal)
    if (result !== 'unavailable') return result === 'finished'
  }
  if (signal.aborted) return false
  if (isAndroidWakeClient() && typeof AudioContext !== 'undefined') {
    const result = await playAndroidChime(signal)
    if (result !== 'unavailable') return result === 'finished'
  }
  if (signal.aborted || !audio) return false

  return new Promise<boolean>(resolve => {
    let finished = false
    const finish = (played: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', failed)
      audio.removeEventListener('ended', ended)
      audio.removeEventListener('error', failed)
      audio.removeEventListener('playing', playing)
      if (!played) audio.pause()
      resolve(played)
    }
    const ended = () => finish(true)
    const failed = () => finish(false)
    const playing = () => {
      clearTimeout(timer)
      timer = setTimeout(failed, completionTimeout)
    }
    let timer = setTimeout(failed, startupTimeout)
    signal.addEventListener('abort', failed, { once: true })
    audio.addEventListener('ended', ended, { once: true })
    audio.addEventListener('error', failed, { once: true })
    audio.addEventListener('playing', playing, { once: true })
    try {
      audio.currentTime = 0
      void audio.play().catch(failed)
    } catch { failed() }
  })
}
