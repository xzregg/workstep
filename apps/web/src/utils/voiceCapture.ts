import { VoiceResampler } from '../audio/voiceResampler'
import { openVoiceDsp } from '../audio/voiceDsp'
import type { TurnState } from '../audio/turnController'
import { browserDiagnostics } from './browserDiagnostics'

export { VoiceResampler }

export function pcmBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((value, i) => view.setInt16(i * 2, value, true))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export interface VoiceCapture { stop: () => void; flush: () => void | Promise<TurnState | void> }

type CaptureAudio = {
  context: AudioContext
  users: number
  worklet?: Promise<void>
  clearIdle?: () => void
}
let reusableAudio: CaptureAudio | undefined

function acquireCaptureAudio(reuseContext: boolean) {
  const audio: CaptureAudio = reuseContext && reusableAudio
    && !['closed', 'interrupted'].includes(reusableAudio.context.state)
    ? reusableAudio : { context: new AudioContext(), users: 0 }
  if (reuseContext) reusableAudio = audio
  audio.clearIdle?.()
  audio.users++
  return {
    context: audio.context,
    loadWorklet() {
      return audio.worklet ??= audio.context.audioWorklet
        .addModule(new URL('../audio/voiceCapture.worklet.js?no-inline', import.meta.url).href)
        .catch(error => { audio.worklet = undefined; throw error })
    },
    release(allowReuse: boolean) {
      if (--audio.users > 0) return
      const close = () => {
        audio.clearIdle?.()
        if (reusableAudio === audio) reusableAudio = undefined
        void audio.context.close().catch(() => {})
      }
      if (allowReuse && reusableAudio === audio && !document.hidden) {
        // Only retain the disconnected graph. Microphone tracks stop before this runs.
        const hide = () => { if (document.hidden) close() }
        const timer = setTimeout(close, 1500)
        const clearIdle = audio.clearIdle = () => {
          clearTimeout(timer)
          document.removeEventListener('visibilitychange', hide)
          window.removeEventListener('pagehide', close)
          audio.clearIdle = undefined
        }
        document.addEventListener('visibilitychange', hide)
        window.addEventListener('pagehide', close)
        queueMicrotask(() => {
          if (audio.clearIdle === clearIdle) void audio.context.suspend().catch(() => {
            if (audio.clearIdle === clearIdle) close()
          })
        })
      } else close()
    },
  }
}

export async function captureVoice(onChunk: (pcm: Int16Array, level: number, turn?: TurnState, capturedAt?: number) => void,
  signal: AbortSignal, detectSpeech = false, frameSamples = 8000,
  { reuseContext = false, continuous = false, phoneCall = false }:
    { reuseContext?: boolean; continuous?: boolean; phoneCall?: boolean } = {}): Promise<VoiceCapture> {
  const checkCancelled = () => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError') }
  checkCancelled()
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('speech.secureRequired')
  const policyDocument = document as Document & {
    permissionsPolicy?: { allowsFeature: (feature: string) => boolean }
    featurePolicy?: { allowsFeature: (feature: string) => boolean }
  }
  const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy
  if (policy && !policy.allowsFeature('microphone')) throw new Error('speech.pageMicrophoneBlocked')
  // Create/resume in the user gesture before awaiting permission (iOS).
  const audio = acquireCaptureAudio(reuseContext)
  const { context } = audio
  // Start resuming in the gesture, but do not await it before getUserMedia:
  // some WebViews keep Web Audio suspended until capture has been granted.
  void context.resume().catch(() => {})
  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let node: AudioWorkletNode | undefined
  let dsp: ReturnType<typeof openVoiceDsp> | undefined
  let pending: number[] = []
  let level = 0
  let closed = false
  let graphReady = false
  let finishFlush: (() => void) | undefined
  let settleFlush: (() => void) | undefined
  let flushing: Promise<TurnState | void> | undefined
  const flushPending = () => {
    if (pending.length) { const samples = Int16Array.from(pending); pending = []; onChunk(samples, level) }
  }
  const flush = () => {
    if (closed || !node?.port.postMessage) { flushPending(); return }
    if (flushing) return flushing
    flushing = new Promise<TurnState | void>((resolve, reject) => {
      // The acknowledgement follows all audio messages already posted by the
      // render thread. Bound the wait if a WebView suspends that thread.
      const complete = (turn?: TurnState) => {
        clearTimeout(timer); finishFlush = settleFlush = undefined; flushPending(); resolve(turn)
      }
      const timer = setTimeout(() => {
        if (dsp) { finishFlush = settleFlush = undefined; reject(new Error('speech.recordingCheckTimeout')) }
        else complete()
      }, dsp ? 2500 : 150)
      settleFlush = () => complete()
      finishFlush = () => {
        if (dsp) void dsp.checkpoint().then(complete)
        else complete()
      }
      node!.port.postMessage({ type: 'flush' })
    }).finally(() => { flushing = undefined })
    return flushing
  }
  const stop = (allowReuse = graphReady) => {
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    stream = undefined
    if (closed) return
    closed = true
    settleFlush?.()
    dsp?.close()
    source?.disconnect(); node?.disconnect()
    if (node) {
      node.port.onmessage = null
      node.port.close?.()
    }
    audio.release(allowReuse)
    signal.removeEventListener('abort', abort)
  }
  const abort = () => stop()
  signal.addEventListener('abort', abort, { once: true })
  try {
    checkCancelled()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
    } catch (error) {
      checkCancelled()
      if (!(error instanceof DOMException) || !['NotReadableError', 'OverconstrainedError'].includes(error.name)) throw error
      // Some Android audio drivers cannot open the processed voice source.
      // Retry once with processing disabled and the device's native channels.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    }
    if (signal.aborted) { stop(); throw new DOMException('Cancelled', 'AbortError') }
    const tracks = stream.getAudioTracks()
    const lost = () => {
      graphReady = false
      if (!signal.aborted) signal.dispatchEvent(new Event('error'))
    }
    if (tracks.some(track => track.readyState === 'ended')) throw new Error('speech.deviceLost')
    tracks.forEach(track => { track.onended = lost })
    try {
      await context.resume()
      checkCancelled()
      await audio.loadWorklet()
      checkCancelled()
      source = context.createMediaStreamSource(stream)
      node = new AudioWorkletNode(context, 'workstep-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { timestamped: detectSpeech } })
      // The silent output keeps browsers rendering the Worklet.
      node.connect(context.destination)
      source.connect(node)
    } catch (error) {
      checkCancelled()
      browserDiagnostics.recordError(error)
      throw new Error('speech.audioCaptureFailed')
    }
    const resampler = new VoiceResampler(context.sampleRate)
    if (detectSpeech) {
      try {
        dsp = openVoiceDsp(context.sampleRate, onChunk, reason => {
          graphReady = false
          signal.dispatchEvent(new CustomEvent('vaderror', { detail: reason }))
        }, continuous, phoneCall)
      } catch (error) {
        browserDiagnostics.recordError(error)
        throw new Error('speech.vadUnavailable')
      }
    }
    node.port.onmessage = ({ data }: MessageEvent<Float32Array | { type: 'audio'; samples: Float32Array; endFrame: number } | { type: 'flushed' | 'discontinuity' }>) => {
      if (signal.aborted || closed) return
      if (!(data instanceof Float32Array)) {
        if (data?.type === 'flushed') finishFlush?.()
        if (data?.type === 'discontinuity') dsp?.discontinuity()
        if (data?.type === 'audio') {
          const ageMs = Math.max(0, (context.currentTime - data.endFrame / context.sampleRate) * 1000)
          dsp?.push(data.samples, performance.now() - ageMs)
        }
        return
      }
      if (dsp) { dsp.push(data, performance.now()); return }
      const samples = resampler.push(data)
      for (const sample of samples) pending.push(sample)
      level = Math.min(1, Math.sqrt(data.reduce((sum, v) => sum + v*v, 0) / data.length) * 5)
      while (pending.length >= frameSamples) {
        onChunk(Int16Array.from(pending.splice(0, frameSamples)), level)
      }
    }
    graphReady = true
    return { stop: () => stop(), flush }
  } catch (error) {
    stop(false)
    if (error instanceof DOMException && error.name === 'NotReadableError') throw new Error('speech.audioSourceUnavailable')
    if (error instanceof DOMException && error.name === 'NotFoundError') throw new Error('speech.microphoneNotFound')
    throw error
  }
}

export const voiceCapture = { start: captureVoice }
