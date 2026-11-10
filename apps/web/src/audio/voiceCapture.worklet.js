/* Runs on the audio rendering thread. Never performs network or model work. */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(Math.max(128, Math.round(sampleRate / 50)))
    this.length = 0
    this.port.onmessage = event => {
      if (event.data?.type === 'flush') {
        this.flush()
        this.port.postMessage({ type: 'flushed' })
      }
    }
  }
  flush() {
    if (!this.length) return
    this.port.postMessage(this.buffer.slice(0, this.length))
    this.length = 0
  }
  process(inputs) {
    const samples = inputs[0]?.[0]
    if (samples) {
      let offset = 0
      while (offset < samples.length) {
        const count = Math.min(samples.length - offset, this.buffer.length - this.length)
        this.buffer.set(samples.subarray(offset, offset + count), this.length)
        this.length += count
        offset += count
        if (this.length === this.buffer.length) this.flush()
      }
    }
    return true
  }
}
registerProcessor('workstep-voice-capture', VoiceCaptureProcessor)
