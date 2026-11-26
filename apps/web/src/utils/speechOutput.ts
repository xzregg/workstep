import { speechOutputApi, type OutputSettings } from '../api/speechOutput'
import { ApiError } from '../api/transport'

export type SpeechAudioChunk = { audio: string; format: 'pcm' | 'wav'; sampleRate: number }

class TemporarySpeechError extends Error {}

const BATCH_WAIT_MS = 350

/** Completed replies keep their prosody context; split only at the API size bound. */
export function completedSpeechBatches(text: string) {
  const batches: string[] = []
  let rest = text.trim()
  while (rest.length > 1200) {
    const end = speechCut(rest, 1200)
    batches.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) batches.push(rest)
  return batches
}

export function streamingSpeechLimit(settings: OutputSettings) {
  if (settings.mode === 'local' && settings.model_id === 'moss-nano') return 60
  if (settings.mode === 'local' && settings.model_id === 'omnivoice') return 80
  if (settings.mode !== 'system' && settings.provider === 'tencent') return 120
  return 160
}

async function requestAudio<Result>(request: Promise<Result>) {
  try { return await request }
  catch (reason) {
    if (reason instanceof TypeError || (reason instanceof ApiError && [408, 429, 500, 502, 503, 504].includes(reason.status))) {
      throw new TemporarySpeechError('Speech service is temporarily unavailable. Try again.')
    }
    if (reason instanceof ApiError && [401, 403].includes(reason.status)) throw new Error('Voice service access is unauthorized. Please check login and permissions:')
    throw reason
  }
}

function retryDelay(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, 350)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

function inlineSpeechText(markdown: string) {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1').replace(/(^|[\s(（])~~(?=\S)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/[*_`#>]/g, '')
}

function blockSpeechText(markdown: string) {
  return markdown.replace(/^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})\r?$/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|(?=\r?$))(?:\[[ xX]\](?:[ \t]+|(?=\r?$)))?/gm, '')
}

function tableCells(line: string) {
  // Only unescaped pipes delimit cells, including after an even run of backslashes.
  const cells = line.trim().split(/(?<=(?:^|[^\\])(?:\\\\)*)\|/)
  if (cells.length === 1 || /^(?: {4}|\t)/.test(line)) return undefined
  if (!cells[0]) cells.shift()
  if (!cells.at(-1)) cells.pop()
  return cells.map(cell => cell.trim())
}

export function speechText(markdown: string, final = true) {
  const text = markdown.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
  if (!text.includes('|')) return inlineSpeechText(blockSpeechText(text))

  const lines = text.split('\n')
  const spoken: string[] = []
  let columns = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], next = lines[index + 1]
    const cells = tableCells(line)
    // A partial row can still gain cells. Keep it out of the playback queue until it ends.
    const pendingRow = next === undefined && (columns || cells)
    const pendingHeader = !columns && cells?.length && index === lines.length - 2 && /^[\s|:-]*$/.test(next)
    if (!final && (pendingRow || pendingHeader)) {
      spoken.push('') // Preserve the newline before the buffered line.
      break
    }
    if (!cells) columns = 0
    if (!columns && cells?.length) {
      const alignment = tableCells(next ?? '')
      if (alignment?.length === cells.length && alignment.every(cell => /^:?-+:?$/.test(cell))) {
        columns = cells.length
        index++
      }
    }
    if (!columns || !cells) {
      spoken.push(blockSpeechText(line))
      continue
    }
    const row = cells.slice(0, columns).map(cell => inlineSpeechText(cell.replace(/\\\|/g, '|')).trim()).filter(Boolean).join('，')
    spoken.push(row && !/[。！？.!?]$/.test(row) ? `${row}。` : row)
  }
  return inlineSpeechText(spoken.join('\n'))
}

const sentenceEnd = /(?:[。！？!?…]+[。！？!?…"'”’」』）》】\])}]*|\.["'”’」』）》】\])}]*(?=\s|$)|\r?\n)/u

function speechCut(text: string, limit: number) {
  // Don't cut through a surrogate pair or trim a boundary from the source text.
  const prefix = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '')
  const boundary = prefix.match(/[\s，、；：,;:](?![\s\S]*[\s，、；：,;:])/u)
  const end = (boundary?.index ?? -1) + 1
  return end >= prefix.length / 2 ? end : prefix.length
}

export function takeSpeechSentences(text: string, final: boolean, earlyOpening = false, limit = 120) {
  const sentences: string[] = []
  let rest = text
  while (rest.length) {
    const match = rest.match(sentenceEnd)
    let end = match?.index === undefined ? -1 : match.index + match[0].length
    if (!final && match?.[0] === '.' && end === rest.length && (!earlyOpening || /\d\.$/.test(rest))) end = -1
    if (earlyOpening && !sentences.length) {
      // A short first clause lets synthesis start while the rest of the reply streams in.
      const opening = rest.match(/^.{8,47}?(?:[，；：]|[,;:](?=\s))/u)?.[0]
        ?? ((end < 0 || end > 48) && /^.{48}/u.test(rest)
          ? rest.match(/^.{23,47}[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u)?.[0]
          : undefined)
      if (opening && (end < 0 || opening.length < end)) end = opening.length
    }
    if ((end < 0 || end > limit) && rest.length >= limit) end = speechCut(rest, limit)
    if (end > 0 && end <= limit) {
      const sentence = rest.slice(0, end).trim()
      if (sentence) sentences.push(sentence)
      rest = rest.slice(end)
    } else break
  }
  if (final && rest.trim()) { sentences.push(rest.trim()); rest = '' }
  return { sentences, rest }
}

function joinSpeech(left: string, right: string) {
  // Preserve an audible sentence boundary for languages that use inter-word spaces.
  const space = /[\p{Script=Latin}\p{N}.!?]["'”’\])]*$/u.test(left) &&
    /^[("'“‘[¿¡]*[\p{Script=Latin}\p{N}]/u.test(right)
  return left + (space ? ' ' : '') + right
}

type QueuedSpeech = { text: string; fixed?: boolean }
type SpeechBatch = { text: string; atomic: boolean }
type PreparedSpeech = SpeechBatch & { created: Promise<{ id: string }> }

let activeOutputPlayer: SpeechOutputPlayer | null = null
let nativeWakePlayback: symbol | undefined
// One gesture-unlocked output graph for the page, reused across conversational turns.
let outputContext:AudioContext|null=null
export function sharedOutputContext(){
  if(!outputContext||outputContext.state==='closed'||!(outputContext instanceof AudioContext))outputContext=new AudioContext()
  return outputContext
}
export function primeSpeechOutput(){
  if(typeof AudioContext==='undefined')return
  try{void sharedOutputContext().resume().catch(()=>{})}catch{/* Playback reports a concrete error if unavailable. */}
}


/** One cancellable playback queue; synthesis overlaps scheduled audio playback. */
export class SpeechOutputPlayer {
  private controller = new AbortController()
  private context: AudioContext | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private queue: QueuedSpeech[] = []
  private pumping = false
  private prepared: PreparedSpeech | null = null
  private submitted = false
  private final = false
  private pendingSince: number | null = null
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private until = 0
  private utterance: SpeechSynthesisUtterance | null = null
  private active = false
  private startedPlayback = false
  private pcmTail: number | undefined
  private reference=''
  private playback=false
  private levelTimer:ReturnType<typeof setInterval>|undefined
  private audioFrames=new Map<AudioBufferSourceNode,{start:number;rate:number;data:Float32Array}>()

  private options: { settings: OutputSettings; projectId?: string; systemVoice?: string; preview?: boolean; previewPrompt?: string; digitalSessionId?: string; coalesce?: boolean; batchStreaming?: boolean; completeReply?: boolean;
    cachedAudio?: { text: string; chunks: readonly SpeechAudioChunk[] }; audioGain?: number; leadingSilence?: number; wakeGreeting?: boolean;
    onInterrupt?: () => void; onState?: (active: boolean) => void; onError?: (error: Error) => void;
    onRecovery?: (error: Error, remaining: string[], submitted: number) => void;
    onReference?: (text:string)=>void; onPlayback?: (active:boolean)=>void; onLevel?: (level:number)=>void }

  constructor(options: SpeechOutputPlayer['options']) { this.options = options }

  get hasStartedPlayback() { return this.startedPlayback }

  /** Call from the user's playback gesture to unlock browser audio before I/O. */
  async unlock() {
    if (this.options.settings.mode !== 'system') {
      this.context ??= sharedOutputContext()
      const signal = this.controller.signal
      signal.throwIfAborted()
      const resumed = this.context.resume()
      await new Promise<void>((resolve, reject) => {
        const abort = () => finish(signal.reason)
        const finish = (error?: unknown) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort)
          if (error) reject(error); else resolve()
        }
        const timer = setTimeout(() => finish(new Error('Unable to start audio playback. Please click Retry.')), 2000)
        signal.addEventListener('abort', abort, { once: true })
        void resumed.then(() => finish(), finish)
      })
    }
  }

  enqueue(sentences: string[], { final = false, submitted = 0 } = {}) {
    if (this.controller.signal.aborted || (!sentences.length && (!final || !this.queue.length))) return
    if (!this.options.wakeGreeting && (nativeWakePlayback || (activeOutputPlayer !== this && activeOutputPlayer?.options.wakeGreeting))) {
      this.options.onInterrupt?.()
      return
    }
    this.final ||= final
    if (activeOutputPlayer !== this) {
      const previous = activeOutputPlayer
      activeOutputPlayer = this
      previous?.options.onInterrupt?.()
      previous?.stop()
    }
    if (!this.queue.length) this.pendingSince = Date.now()
    const limit = streamingSpeechLimit(this.options.settings)
    sentences.forEach((text, index) => {
      const fixed = index < submitted
      const parts = this.options.batchStreaming && text.length > limit
        ? takeSpeechSentences(text, true, false, limit).sentences
        : [text]
      for (const part of parts) this.queue.push({ text: part, fixed })
    })
    this.state(true)
    void this.pump()
    this.prepareNext()
  }

  private clearBatchTimer() {
    clearTimeout(this.batchTimer)
    this.batchTimer = undefined
  }

  private takeBatch(wait: boolean): SpeechBatch | undefined {
    const first = this.queue[0]
    if (!first) return
    const { batchStreaming, coalesce, settings } = this.options
    const limit = batchStreaming ? streamingSpeechLimit(settings) : 160
    const merge = this.submitted && !first.fixed && (batchStreaming || coalesce)
    let text = first.text, count = 1
    if (merge) {
      while (count < this.queue.length && !this.queue[count].fixed) {
        const combined = joinSpeech(text, this.queue[count].text)
        if (combined.length > limit) break
        text = combined
        count++
      }
    }
    if (wait && batchStreaming && merge && !this.final && count === this.queue.length && text.length < limit && this.pendingSince !== null) {
      const delay = BATCH_WAIT_MS - (Date.now() - this.pendingSince)
      if (delay > 0) {
        this.batchTimer ??= setTimeout(() => {
          this.batchTimer = undefined
          void this.pump()
          this.prepareNext()
        }, delay)
        return
      }
    }
    this.clearBatchTimer()
    this.queue.splice(0, count)
    if (!this.queue.length) this.pendingSince = null
    const atomic = !!batchStreaming && (this.submitted || !!first.fixed)
    this.submitted = true
    return { text, atomic }
  }

  private state(active: boolean) {
    if (!active) this.startedPlayback = false
    if (this.active !== active) { this.active = active; this.options.onState?.(active) }
  }

  private output(active:boolean,level=0){
    if (active) this.startedPlayback = true
    if(this.playback!==active){this.playback=active;this.options.onPlayback?.(active)}
    this.options.onLevel?.(level)
  }

  private trackAudio(){
    if(this.levelTimer)return
    this.levelTimer=setInterval(()=>{
      const now=this.context?.currentTime??0
      let active=false,level=0
      for(const frame of this.audioFrames.values()){
        const index=Math.floor((now-frame.start)*frame.rate)
        if(index<0||index>=frame.data.length)continue
        active=true;let sum=0,count=0
        for(let i=index;i<Math.min(index+512,frame.data.length);i++){sum+=frame.data[i]*frame.data[i];count++}
        level=Math.max(level,Math.min(1,Math.sqrt(sum/Math.max(1,count))*5))
      }
      this.output(active,level)
      if(!this.audioFrames.size){clearInterval(this.levelTimer);this.levelTimer=undefined}
    },50)
  }

  private async system(text: string, committed: () => void) {
    if (window.WorkStepSpeech) {
      this.output(true,.35)
      try { await nativeSpeech(text, this.options.settings, this.controller.signal, committed) } finally { this.output(false) }
      return
    }
    if (window.WorkStepAndroid && (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined')) throw new Error('Please update the WorkStep Android app to use the system voice, or select a local model/cloud service in the voice settings.')
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') throw new Error('This device does not support system voice')
    await new Promise<void>((resolve, reject) => {
      const speech = new SpeechSynthesisUtterance(text)
      speech.lang = 'zh-CN'; speech.rate = this.options.settings.rate; speech.volume = this.options.settings.volume
      speech.voice = window.speechSynthesis.getVoices().find(v => v.name === this.options.systemVoice) ?? null
      speech.onstart = () => { committed(); this.output(true,.35) }
      speech.onboundary = () => { committed(); this.output(true,.7) }
      speech.onend = () => { this.output(false); this.utterance = null; resolve() }
      speech.onerror = () => { this.output(false); this.utterance = null; reject(new Error('System voice playback failed')) }
      this.utterance = speech
      this.controller.signal.addEventListener('abort', () => resolve(), { once: true })
      window.speechSynthesis.speak(speech)
    })
  }

  private async decode(audio: string, format: 'pcm' | 'wav', sampleRate: number) {
    await this.unlock()
    this.controller.signal.throwIfAborted()
    const context = this.context!
    const raw = Uint8Array.from(atob(audio), c => c.charCodeAt(0))
    if (format === 'wav') return context.decodeAudioData(raw.buffer)
    const bytes = this.pcmTail === undefined ? raw : Uint8Array.from([this.pcmTail, ...raw])
    this.pcmTail = bytes.length % 2 ? bytes[bytes.length - 1] : undefined
    const length = Math.floor(bytes.length / 2)
    if (!length) return
    const buffer = context.createBuffer(1, length, sampleRate)
    const channel = buffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, length * 2)
    for (let i = 0; i < length; i++) channel[i] = view.getInt16(i * 2, true) / 32768
    return buffer
  }

  private async buffer(audio: string, format: 'pcm' | 'wav', sampleRate: number, rateFactor?: number) {
    const buffer = await this.decode(audio, format, sampleRate)
    if (buffer) return this.schedule(buffer, rateFactor)
  }

  private async schedule(buffer: AudioBuffer, rateFactor = 1) {
    const context = this.context
    if (!context || this.controller.signal.aborted) return
    // Bound queued sound to five seconds so a fast generator cannot grow memory indefinitely.
    while (!this.controller.signal.aborted && this.until - context.currentTime > 5) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    if (this.controller.signal.aborted) return
    const source = context.createBufferSource(), gain = context.createGain()
    const rate = Math.max(.5, Math.min(2, this.options.settings.rate * rateFactor))
    if (!this.until && this.options.leadingSilence) {
      const padding = Math.ceil(this.options.leadingSilence * buffer.sampleRate * rate)
      const padded = context.createBuffer(buffer.numberOfChannels, buffer.length + padding, buffer.sampleRate)
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        padded.getChannelData(channel).set(buffer.getChannelData(channel), padding)
      }
      buffer = padded
    }
    source.buffer = buffer; source.playbackRate.value = rate
    const samples = buffer.getChannelData(0)
    let volume = this.options.settings.volume
    if (this.options.audioGain && this.options.audioGain > 1) {
      let peak = 0
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample))
      }
      volume = Math.min(volume * this.options.audioGain, Math.max(volume, .98 / peak))
    }
    gain.gain.value = volume; source.connect(gain); gain.connect(context.destination)
    const cleanup = () => {
      this.sources.delete(source); this.audioFrames.delete(source); source.disconnect(); gain.disconnect()
      if(!this.audioFrames.size)this.output(false)
      if (!this.pumping && !this.sources.size) {
        if (this.queue.length || this.prepared) void this.pump()
        else this.state(false)
      }
    }
    source.onended = cleanup
    const start = Math.max(context.currentTime + .03, this.until)
    try { source.start(start) } catch (reason) { cleanup(); throw reason }
    this.startedPlayback = true
    this.sources.add(source)
    this.until = start + buffer.duration / rate
    this.audioFrames.set(source,{start,rate:buffer.sampleRate*rate,data:samples})
    this.trackAudio()
    return true
  }

  private startSession(text: string) {
    const { projectId, preview, previewPrompt, settings, digitalSessionId } = this.options
    if (!preview && digitalSessionId && settings.mode === 'local' && ['cosyvoice3', 'omnivoice'].includes(settings.model_id)) {
      return speechOutputApi.start(text, projectId, undefined, undefined, digitalSessionId)
    }
    return preview && previewPrompt
      ? speechOutputApi.start(text, projectId, settings, previewPrompt)
      : speechOutputApi.start(text, projectId, preview ? settings : undefined)
  }

  private prepareNext(){
    if (!this.pumping || this.options.completeReply || this.options.settings.mode === 'system' || this.prepared || this.controller.signal.aborted) return
    if (this.options.cachedAudio && this.options.cachedAudio.text === this.queue[0]?.text) return
    const batch = this.takeBatch(true)
    if (!batch) return
    const created = this.startSession(batch.text)
    this.prepared = { ...batch, created }
    // Keep the rejection observable to the pump without an unhandled promise.
    void created.catch(()=>{})
  }

  private async synthesize(batch: SpeechBatch, committed: () => void, prepared?: Promise<{ id: string }>) {
    const { text } = batch
    const { projectId = '', cachedAudio, wakeGreeting } = this.options
    const atomic = batch.atomic || wakeGreeting
    if (cachedAudio?.text === text) {
      this.pcmTail = undefined
      for (const { audio, format, sampleRate } of cachedAudio.chunks) {
        this.controller.signal.throwIfAborted()
        if (await this.buffer(audio, format, sampleRate)) committed()
      }
      if (this.pcmTail !== undefined) throw new Error('Audio data is incomplete')
      return
    }
    // Do not abort session creation: always collect its ID for cleanup.
    const creating = prepared ?? this.startSession(text)
    this.prepareNext()
    const { id } = await requestAudio(creating)
    try {
      this.pcmTail = undefined
      const pending: Array<Parameters<SpeechOutputPlayer['buffer']>> = []
      let greetingSize = 0
      const play = async (chunk: Parameters<SpeechOutputPlayer['buffer']>) => {
        try { if (await this.buffer(...chunk)) committed() }
        catch { throw new Error('Audio playback failed, please click retry') }
      }
      while (!this.controller.signal.aborted) {
        const event = await requestAudio(speechOutputApi.next(id, projectId, this.controller.signal))
        if (event.error) throw event.error_code === 'temporary' ? new TemporarySpeechError(event.error) : new Error(event.error)
        if (event.audio) {
          if (wakeGreeting && (greetingSize += event.audio.length) > 1024 * 1024) {
            throw new Error('Wake greeting audio exceeds its size limit')
          }
          const chunk: Parameters<SpeechOutputPlayer['buffer']> = [event.audio, event.format!, event.sample_rate!, event.rate_factor]
          // A merged stream has no sentence offsets. Wait for completion so a
          // connection failure can't leave half the batch spoken and half lost.
          if (atomic) pending.push(chunk)
          else await play(chunk)
        }
        if (event.done) {
          if (!atomic) {
            if (this.pcmTail !== undefined) throw new Error('Audio data is incomplete')
            return
          }
          const decoded: Array<{ buffer: AudioBuffer; rate?: number }> = []
          try {
            for (const [audio, format, rate, factor] of pending) {
              const buffer = await this.decode(audio, format, rate)
              if (buffer) decoded.push({ buffer, rate: factor })
            }
            if (this.pcmTail !== undefined) throw new Error('Audio data is incomplete')
            for (const { buffer, rate } of decoded) {
              if (await this.schedule(buffer, rate)) committed()
            }
          } catch {
            throw new Error('Audio playback failed, please click retry')
          }
          return
        }
      }
    } finally {
      await speechOutputApi.cancel(id, projectId).catch(() => {})
    }
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    let batch: SpeechBatch | undefined, committed = false
    const markCommitted = () => { committed = true }
    try {
      while (!this.controller.signal.aborted) {
        // A long complete reply can play for minutes. Do not create its successor
        // while it would sit unread past the server session's idle timeout.
        while (this.options.completeReply && !this.controller.signal.aborted && this.context && this.until - this.context.currentTime > 5) {
          await new Promise(resolve => setTimeout(resolve, 30))
        }
        const prepared = this.prepared
        this.prepared = null
        const covered = !!this.context && this.sources.size > 0 && this.until - this.context.currentTime > BATCH_WAIT_MS / 1000
        batch = prepared ?? this.takeBatch(covered)
        if (!batch) break
        this.reference = (this.reference.slice(-4096) + ' ' + batch.text).trimStart()
        this.options.onReference?.(this.reference)
        committed = false
        if (this.options.settings.mode === 'system') await this.system(batch.text, markCommitted)
        else {
          try { await this.synthesize(batch, markCommitted, prepared?.created) }
          catch (reason) {
            if (!this.options.onRecovery || committed || !(reason instanceof TemporarySpeechError)) throw reason
            await retryDelay(this.controller.signal)
            if (!this.controller.signal.aborted) await this.synthesize(batch, markCommitted)
          }
        }
      }
    } catch (reason) {
      if (!this.controller.signal.aborted) {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        if (this.options.onRecovery) {
          const submitted = [...(!committed && batch ? [batch.text] : []), ...(this.prepared ? [this.prepared.text] : [])]
          const remaining = [...submitted, ...this.queue.map(entry => entry.text)]
          const firstUnsubmitted = this.queue.findIndex(entry => !entry.fixed)
          const fixed = submitted.length + (firstUnsubmitted < 0 ? this.queue.length : firstUnsubmitted)
          this.queue = []
          this.pendingSince = null
          this.clearBatchTimer()
          this.cancelPrepared()
          if (this.context && this.context.state !== 'running') this.stop()
          this.options.onRecovery(error, remaining, fixed)
        } else {
          this.stop()
          this.options.onError?.(error)
        }
      }
    } finally {
      this.pumping = false
      if (!this.sources.size && !this.queue.length && !this.prepared) this.state(false)
    }
  }

  private cancelPrepared() {
    const prepared=this.prepared;this.prepared=null
    if(prepared)void prepared.created.then(({id})=>speechOutputApi.cancel(id,this.options.projectId??'')).catch(()=>{})
  }

  stop() {
    if (activeOutputPlayer === this) activeOutputPlayer = null
    this.controller.abort(); this.queue = []
    this.clearBatchTimer()
    this.cancelPrepared()
    clearInterval(this.levelTimer);this.levelTimer=undefined;this.audioFrames.clear();this.output(false)
    if (this.utterance) {
      this.utterance.onstart = null; this.utterance.onboundary = null; this.utterance.onend = null; this.utterance.onerror = null
      window.speechSynthesis?.cancel(); this.utterance = null
    }
    for (const source of this.sources) { source.onended = null; try { source.stop() } catch { /* already ended */ } }
    this.sources.clear()
    this.context = null; this.state(false)
  }

  static reserveNativeWakePlayback() {
    const owner = nativeWakePlayback = Symbol()
    const previous = activeOutputPlayer
    previous?.options.onInterrupt?.()
    previous?.stop()
    return () => { if (nativeWakePlayback === owner) nativeWakePlayback = undefined }
  }
}


declare global {
  interface Window {
    WorkStepSpeech?: { postMessage(message: string): void; onmessage: null | ((event: { data: string }) => void) }
  }
}
let speechSequence = 0
const nativePending = new Map<string, (result: { status: string; error?: string }) => void>()
function nativeSpeech(text: string, settings: OutputSettings, signal: AbortSignal, committed: () => void) {
  const bridge = window.WorkStepSpeech!
  const id = `speech-${Date.now()}-${++speechSequence}`
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: string) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); nativePending.delete(id)
      if (error) reject(new Error(error)); else resolve()
    }
    const abort = () => { bridge.postMessage(JSON.stringify({ type: 'stop', id })); finish() }
    const timeout = Math.max(60000, Math.min(600000, text.length * 500))
    const timer = setTimeout(() => { bridge.postMessage(JSON.stringify({ type: 'stop', id })); finish('System speech timed out. Check the device text-to-speech settings.') }, timeout)
    bridge.onmessage = event => {
      try {
        const result = JSON.parse(event.data)
        nativePending.get(result.id)?.(result)
      } catch { /* Ignore unrelated or malformed native messages. */ }
    }
    nativePending.set(id, result => finish(result.status === 'error' ? result.error || 'System speech playback failed' : undefined))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try { bridge.postMessage(JSON.stringify({ type: 'speak', id, text, rate: settings.rate, volume: settings.volume })); committed() }
    catch (error) { finish(error instanceof Error ? error.message : String(error)) }
  })
}
