import { VoiceResampler } from '../audio/voiceResampler'
import { openVoiceDsp } from '../audio/voiceDsp'
import type { TurnState } from '../audio/turnController'

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
export async function captureVoice(onChunk: (pcm: Int16Array, level: number, turn?: TurnState) => void,
  signal: AbortSignal, detectSpeech = false, frameSamples = 8000): Promise<VoiceCapture> {
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
  const context = new AudioContext()
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
  const stop = () => {
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    stream = undefined
    if (closed) return
    closed = true
    settleFlush?.()
    dsp?.close()
    source?.disconnect(); node?.disconnect()
    if (node) node.port.onmessage = null
    void context.close().catch(() => {})
    signal.removeEventListener('abort', stop)
  }
  signal.addEventListener('abort', stop, { once: true })
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
    await context.resume()
    checkCancelled()
    await context.audioWorklet.addModule(new URL('../audio/voiceCapture.worklet.js?no-inline', import.meta.url).href)
    if (signal.aborted) { stop(); throw new DOMException('Cancelled', 'AbortError') }
    const resampler = new VoiceResampler(context.sampleRate)
    if (detectSpeech) dsp = openVoiceDsp(context.sampleRate, onChunk, () => signal.dispatchEvent(new Event('vaderror')))
    source = context.createMediaStreamSource(stream)
    node = new AudioWorkletNode(context, 'workstep-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    // The processor leaves output silent; connecting it keeps the audio graph
    // rendering on browsers that suspend disconnected worklets.
    node.connect(context.destination)
    node.port.onmessage = (event: MessageEvent<Float32Array | { type: string }>) => {
      if (signal.aborted || closed) return
      if (!(event.data instanceof Float32Array)) {
        if (event.data?.type === 'flushed') finishFlush?.()
        if (event.data?.type === 'discontinuity') dsp?.discontinuity()
        return
      }
      if (dsp) { dsp.push(event.data); return }
      const samples = resampler.push(event.data)
      for (const sample of samples) pending.push(sample)
      level = Math.min(1, Math.sqrt(event.data.reduce((sum, v) => sum + v*v, 0) / event.data.length) * 5)
      while (pending.length >= frameSamples) {
        onChunk(Int16Array.from(pending.splice(0, frameSamples)), level)
      }
    }
    stream.getAudioTracks().forEach(track => { track.onended = () => { if (!signal.aborted) signal.dispatchEvent(new Event('error')) } })
    source.connect(node)
    return { stop, flush }
  } catch (error) {
    stop()
    if (error instanceof DOMException && error.name === 'NotReadableError') throw new Error('speech.audioSourceUnavailable')
    if (error instanceof DOMException && error.name === 'NotFoundError') throw new Error('speech.microphoneNotFound')
    throw error
  }
}

export const voiceCapture = { start: captureVoice }
