import { speechOutputApi, type OutputSettings } from '../api/speechOutput'
import { ApiError } from '../api/transport'

export type SpeechAudioChunk = { audio: string; format: 'pcm' | 'wav'; sampleRate: number }

class TemporarySpeechError extends Error {}

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

export function takeSpeechSentences(text: string, final: boolean, earlyOpening = false) {
  const sentences: string[] = []
  let rest = text
  while (rest.length) {
    const match = rest.match(/[。！？!?\n]|\.(?=\s|$)/)
    let end = match?.index === undefined ? -1 : match.index + 1
    if (earlyOpening && !sentences.length) {
      // A short first clause lets synthesis start while the rest of the reply streams in.
      const opening = rest.match(/^.{8,47}?(?:[，；：]|[,;:](?=\s))/u)?.[0]
        ?? ((end < 0 || end > 48) && /^.{48}/u.test(rest)
          ? rest.match(/^.{23,47}[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u)?.[0]
          : undefined)
      if (opening && (end < 0 || opening.length < end)) end = opening.length
    }
    if (end > 0 && end <= 120) {
      const sentence = rest.slice(0, end).trim()
      if (sentence) sentences.push(sentence)
      rest = rest.slice(end)
    } else if (rest.length >= 120) {
      sentences.push(rest.slice(0, 120)); rest = rest.slice(120)
    } else break
  }
  if (final && rest.trim()) { sentences.push(rest.trim()); rest = '' }
  return { sentences, rest }
}

let activeOutputPlayer: SpeechOutputPlayer | null = null
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
  private queue: string[] = []
  private pumping = false
  private prepared: {text:string;created:Promise<{id:string}>} | null = null
  private until = 0
  private utterance: SpeechSynthesisUtterance | null = null
  private active = false
  private pcmTail: number | undefined
  private playback=false
  private levelTimer:ReturnType<typeof setInterval>|undefined
  private audioFrames=new Map<AudioBufferSourceNode,{start:number;rate:number;data:Float32Array}>()

  private options: { settings: OutputSettings; projectId?: string; systemVoice?: string; preview?: boolean; previewPrompt?: string; digitalSessionId?: string; coalesce?: boolean;
    cachedAudio?: { text: string; chunks: readonly SpeechAudioChunk[] }; audioGain?: number;
    onInterrupt?: () => void; onState?: (active: boolean) => void; onError?: (error: Error) => void;
    onRecovery?: (error: Error, remaining: string[]) => void;
    onPlayback?: (active:boolean)=>void; onLevel?: (level:number)=>void }

  constructor(options: SpeechOutputPlayer['options']) { this.options = options }

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

  enqueue(sentences: string[]) {
    if (this.controller.signal.aborted || !sentences.length) return
    if (activeOutputPlayer !== this) {
      const previous = activeOutputPlayer
      activeOutputPlayer = this
      previous?.options.onInterrupt?.()
      previous?.stop()
    }
    const keepOpening = !this.pumping && !this.sources.size && !this.queue.length
    for(const sentence of sentences){
      const last=this.queue.length-1
      if(this.options.coalesce&&last>=0&&!(last===0&&(keepOpening||this.prepared))&&this.queue[last].length+sentence.length<=160)this.queue[last]+=sentence
      else this.queue.push(sentence)
    }
    this.state(true)
    void this.pump()
    this.prepareNext()
  }

  private state(active: boolean) {
    if (this.active !== active) { this.active = active; this.options.onState?.(active) }
  }

  private output(active:boolean,level=0){
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

  private async buffer(audio: string, format: 'pcm' | 'wav', sampleRate: number, rateFactor = 1) {
    await this.unlock()
    const context = this.context!
    const raw = Uint8Array.from(atob(audio), c => c.charCodeAt(0))
    let buffer: AudioBuffer
    if (format === 'wav') {
      buffer = await context.decodeAudioData(raw.buffer)
    } else {
      const bytes = this.pcmTail === undefined ? raw : Uint8Array.from([this.pcmTail, ...raw])
      this.pcmTail = bytes.length % 2 ? bytes[bytes.length - 1] : undefined
      const length = Math.floor(bytes.length / 2)
      if (!length) return
      buffer = context.createBuffer(1, length, sampleRate)
      const channel = buffer.getChannelData(0)
      const view = new DataView(bytes.buffer, bytes.byteOffset, length * 2)
      for (let i = 0; i < length; i++) channel[i] = view.getInt16(i * 2, true) / 32768
    }
    // Bound queued sound to five seconds so a fast generator cannot grow memory indefinitely.
    while (!this.controller.signal.aborted && this.until - context.currentTime > 5) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    if (this.controller.signal.aborted) return
    const source = context.createBufferSource(), gain = context.createGain()
    const rate = Math.max(.5, Math.min(2, this.options.settings.rate * rateFactor))
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
      if (!this.pumping && !this.queue.length && !this.sources.size) this.state(false)
    }
    source.onended = cleanup
    const start = Math.max(context.currentTime + .03, this.until)
    try { source.start(start) } catch (reason) { cleanup(); throw reason }
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
    if(!this.pumping||this.options.settings.mode==='system'||this.prepared||!this.queue.length||this.controller.signal.aborted)return
    const text=this.queue[0]
    if (this.options.cachedAudio?.text === text) return
    const created=this.startSession(text)
    this.prepared={text,created}
    // Keep the rejection observable to the pump without an unhandled promise.
    void created.catch(()=>{})
  }

  private async synthesize(text: string, committed: () => void) {
    const { projectId = '', cachedAudio } = this.options
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
    const prepared=this.prepared?.text===text?this.prepared:null
    if(prepared)this.prepared=null
    const creating=prepared?.created??this.startSession(text)
    this.prepareNext()
    const { id } = await requestAudio(creating)
    try {
      this.pcmTail = undefined
      while (!this.controller.signal.aborted) {
        const event = await requestAudio(speechOutputApi.next(id, projectId, this.controller.signal))
        if (event.error) throw event.error_code === 'temporary' ? new TemporarySpeechError(event.error) : new Error(event.error)
        if (event.audio) {
          try { if (await this.buffer(event.audio, event.format!, event.sample_rate!, event.rate_factor)) committed() }
          catch { throw new Error('Audio playback failed, please click retry') }
        }
        if (event.done) {
          if (this.pcmTail !== undefined) throw new Error('Audio data is incomplete')
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
    let sentence = '', committed = false
    const markCommitted = () => { committed = true }
    try {
      while (this.queue.length && !this.controller.signal.aborted) {
        sentence = this.queue.shift()!
        committed = false
        if (this.options.settings.mode === 'system') await this.system(sentence, markCommitted)
        else {
          try { await this.synthesize(sentence, markCommitted) }
          catch (reason) {
            if (!this.options.onRecovery || committed || !(reason instanceof TemporarySpeechError)) throw reason
            await retryDelay(this.controller.signal)
            if (!this.controller.signal.aborted) await this.synthesize(sentence, markCommitted)
          }
        }
      }
    } catch (reason) {
      if (!this.controller.signal.aborted) {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        if (this.options.onRecovery) {
          const remaining = committed ? this.queue : [sentence, ...this.queue]
          this.queue = []
          this.cancelPrepared()
          if (this.context && this.context.state !== 'running') this.stop()
          this.options.onRecovery(error, remaining)
        } else {
          this.stop()
          this.options.onError?.(error)
        }
      }
    } finally {
      this.pumping = false
      if (!this.sources.size) this.state(false)
    }
  }

  private cancelPrepared() {
    const prepared=this.prepared;this.prepared=null
    if(prepared)void prepared.created.then(({id})=>speechOutputApi.cancel(id,this.options.projectId??'')).catch(()=>{})
  }

  stop() {
    if (activeOutputPlayer === this) activeOutputPlayer = null
    this.controller.abort(); this.queue = []
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
    const timer = setTimeout(() => { bridge.postMessage(JSON.stringify({ type: 'stop', id })); finish('System speech timed out. Check the device text-to-speech settings.') }, 60000)
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
