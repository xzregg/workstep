/** Streaming mono PCM16 conversion for capture and the DSP worker. */
export class VoiceResampler {
  private sum = 0
  private weight = 0
  private rate: number
  constructor(rate: number) { this.rate = rate }
  push(samples: Float32Array): Int16Array {
    const ratio = this.rate / 16000
    const output: number[] = []
    for (const sample of samples) {
      let remaining = 1
      while (remaining > 1e-8) {
        const take = Math.min(remaining, ratio - this.weight)
        this.sum += sample * take
        this.weight += take
        remaining -= take
        if (this.weight >= ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / ratio))
          output.push(Math.round(value * (value < 0 ? 32768 : 32767)))
          this.sum = 0; this.weight = 0
        }
      }
    }
    return Int16Array.from(output)
  }
}
