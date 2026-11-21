export interface VadFrame {
  end: number
  probability: number
}

export interface TurnState {
  lastVoice: number
  hasSpeech: boolean
  candidate: boolean
  canCommit: boolean
}

const CANDIDATE_SAMPLES = 4000
const COMMIT_SAMPLES = 9600

/** Turns use the capture sample clock, including when worker results arrive late. */
export class TurnController {
  private end = 0
  private voiced = 0
  private confident = 0
  lastVoice = 0
  hasSpeech = false

  frame({ end, probability }: VadFrame) {
    this.end = end
    if (probability >= (this.voiced ? 0.35 : 0.5)) {
      this.lastVoice = end
      this.voiced++
      this.confident = probability >= 0.8 ? this.confident + 1 : 0
      // Two confident frames protect brief acknowledgements such as “嗯”.
      if (this.voiced >= 3 || this.confident >= 2) this.hasSpeech = true
    } else {
      this.voiced = 0
      this.confident = 0
    }
  }

  discontinuity(end: number) {
    // Missing audio is not silence. Keep the utterance and require a new pause.
    this.end = this.lastVoice = end
    this.voiced = this.confident = 0
  }

  get candidate() { return this.hasSpeech && this.end - this.lastVoice >= CANDIDATE_SAMPLES }
  get canCommit() { return this.hasSpeech && this.end - this.lastVoice >= COMMIT_SAMPLES }
  snapshot(): TurnState {
    return { lastVoice: this.lastVoice, hasSpeech: this.hasSpeech, candidate: this.candidate, canCommit: this.canCommit }
  }
}
