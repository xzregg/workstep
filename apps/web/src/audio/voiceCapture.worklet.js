/* Runs on the audio rendering thread. Never performs network or model work. */
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0]
    if (samples) this.port.postMessage(samples.slice())
    return true
  }
}
registerProcessor('workstep-voice-capture', VoiceCaptureProcessor)
