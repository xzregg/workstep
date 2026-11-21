import { sharedOutputContext } from '../utils/speechOutput'

const url = new URL('./wake-chime.wav?no-inline', import.meta.url).href
const buffers = new WeakMap<AudioContext, Promise<AudioBuffer>>()

export const isAndroidWakeClient = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  || typeof window !== 'undefined' && !!window.WorkStepAndroid

declare global {
  interface Window {
    WorkStepWakeChime?: NonNullable<Window['WorkStepSpeech']>
  }
}

let chimeSequence = 0
let stopNativeChime: (() => void) | undefined
function playNativeChime(bridge: NonNullable<Window['WorkStepWakeChime']>, signal: AbortSignal) {
  stopNativeChime?.()
  return new Promise<boolean>(resolve => {
    const id = `chime-${++chimeSequence}`
    const finish = (played: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      bridge.onmessage = null
      stopNativeChime = undefined
      resolve(played)
    }
    const stop = () => {
      finish(false)
      try { bridge.postMessage(JSON.stringify({ type: 'stop', id })) } catch { /* Bridge is gone. */ }
    }
    const timer = setTimeout(stop, 1500)
    stopNativeChime = stop
    signal.addEventListener('abort', stop, { once: true })
    bridge.onmessage = event => {
      try {
        const result = JSON.parse(event.data)
        if (result.id === id) finish(result.status === 'done')
      } catch { /* Ignore malformed responses. */ }
    }
    try { bridge.postMessage(JSON.stringify({ type: 'wake-chime', id })) } catch { finish(false) }
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
  return new Promise<boolean>(resolve => {
    let source: AudioBufferSourceNode | undefined
    let started = false
    let finished = false
    const finish = (played: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (source) {
        source.onended = null
        if (started) source.stop()
        source.disconnect()
      }
      resolve(played)
    }
    const abort = () => finish(false)
    const timer = setTimeout(abort, 1500)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const context = sharedOutputContext()
      void Promise.all([context.resume(), chimeBuffer(context)]).then(([, buffer]) => {
        if (finished) return
        source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => finish(true)
        source.start()
        started = true
      }).catch(abort)
    } catch { abort() }
  })
}

export async function playWakeSound(audio: HTMLAudioElement | null, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  const bridge = typeof window !== 'undefined' ? window.WorkStepWakeChime : undefined
  if (bridge && await playNativeChime(bridge, signal)) return true
  if (signal.aborted) return false
  if (isAndroidWakeClient() && typeof AudioContext !== 'undefined' && await playAndroidChime(signal)) return true
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
      audio.pause()
      resolve(played)
    }
    const ended = () => finish(true)
    const failed = () => finish(false)
    const timer = setTimeout(failed, 1800)
    signal.addEventListener('abort', failed, { once: true })
    audio.addEventListener('ended', ended, { once: true })
    audio.addEventListener('error', failed, { once: true })
    try {
      audio.currentTime = 0
      void audio.play().catch(failed)
    } catch { failed() }
  })
}
