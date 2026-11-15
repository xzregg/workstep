import { speechOutputApi, type OutputSettings } from '../api/speechOutput'

export function speechText(markdown: string) {
  return markdown.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/[*_`#>]/g, '')
}

export function takeSpeechSentences(text: string, final: boolean) {
  const sentences: string[] = []
  let rest = text
  while (rest.length) {
    const match = rest.match(/[。！？!?\n]|\.(?=\s|$)/)
    const end = match?.index === undefined ? -1 : match.index + 1
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
function sharedOutputContext(){
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

  private options: { settings: OutputSettings; projectId?: string; systemVoice?: string; preview?: boolean; coalesce?: boolean;
    onInterrupt?: () => void; onState?: (active: boolean) => void; onError?: (error: Error) => void;
    onPlayback?: (active:boolean)=>void; onLevel?: (level:number)=>void }

  constructor(options: SpeechOutputPlayer['options']) { this.options = options }

  /** Call from the user's playback gesture to unlock browser audio before I/O. */
  async unlock() {
    if (this.options.settings.mode !== 'system') {
      this.context ??= sharedOutputContext()
      await this.context.resume()
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
    for(const sentence of sentences){
      const last=this.queue.length-1
      if(this.options.coalesce&&last>=0&&!(last===0&&this.prepared)&&this.queue[last].length+sentence.length<=160)this.queue[last]+=sentence
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

  private async system(text: string) {
    if (window.WorkStepSpeech) {
      this.output(true,.35)
      try { await nativeSpeech(text, this.options.settings, this.controller.signal) } finally { this.output(false) }
      return
    }
    if (window.WorkStepAndroid && (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined')) throw new Error('请更新 WorkStep 安卓应用以使用系统语音，或在语音设置中选择本地模型／云服务')
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') throw new Error('本设备不支持系统语音')
    await new Promise<void>((resolve, reject) => {
      const speech = new SpeechSynthesisUtterance(text)
      speech.lang = 'zh-CN'; speech.rate = this.options.settings.rate; speech.volume = this.options.settings.volume
      speech.voice = window.speechSynthesis.getVoices().find(v => v.name === this.options.systemVoice) ?? null
      speech.onstart = () => this.output(true,.35)
      speech.onboundary = () => this.output(true,.7)
      speech.onend = () => { this.output(false); this.utterance = null; resolve() }
      speech.onerror = () => { this.output(false); this.utterance = null; reject(new Error('系统语音播放失败')) }
      this.utterance = speech
      this.controller.signal.addEventListener('abort', () => resolve(), { once: true })
      window.speechSynthesis.speak(speech)
    })
  }

  private async buffer(audio: string, format: 'pcm' | 'wav', sampleRate: number) {
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
    source.buffer = buffer; source.playbackRate.value = this.options.settings.rate
    gain.gain.value = this.options.settings.volume; source.connect(gain); gain.connect(context.destination)
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source); this.audioFrames.delete(source); source.disconnect(); gain.disconnect()
      if(!this.audioFrames.size)this.output(false)
      if (!this.pumping && !this.queue.length && !this.sources.size) this.state(false)
    }
    const start = Math.max(context.currentTime + .03, this.until)
    this.until = start + buffer.duration / this.options.settings.rate
    this.audioFrames.set(source,{start,rate:buffer.sampleRate*this.options.settings.rate,data:buffer.getChannelData(0)})
    this.trackAudio()
    source.start(start)
  }

  private prepareNext(){
    if(!this.pumping||this.options.settings.mode==='system'||this.prepared||!this.queue.length||this.controller.signal.aborted)return
    const text=this.queue[0]
    const created=speechOutputApi.start(text,this.options.projectId??'',this.options.preview?this.options.settings:undefined)
    this.prepared={text,created}
    // Keep the rejection observable to the pump without an unhandled promise.
    void created.catch(()=>{})
  }

  private async synthesize(text: string) {
    const { projectId = '', settings } = this.options
    // Do not abort session creation: always collect its ID for cleanup.
    const prepared=this.prepared?.text===text?this.prepared:null
    if(prepared)this.prepared=null
    const creating=prepared?.created??speechOutputApi.start(text, projectId, this.options.preview ? settings : undefined)
    this.prepareNext()
    const { id } = await creating
    try {
      this.pcmTail = undefined
      while (!this.controller.signal.aborted) {
        const event = await speechOutputApi.next(id, projectId, this.controller.signal)
        if (event.error) throw new Error(event.error)
        if (event.audio) await this.buffer(event.audio, event.format!, event.sample_rate!)
        if (event.done) {
          if (this.pcmTail !== undefined) throw new Error('音频数据不完整')
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
    try {
      while (this.queue.length && !this.controller.signal.aborted) {
        const sentence = this.queue.shift()!
        if (this.options.settings.mode === 'system') await this.system(sentence)
        else await this.synthesize(sentence)
      }
    } catch (reason) {
      if (!this.controller.signal.aborted) {
        this.stop()
        this.options.onError?.(reason instanceof Error ? reason : new Error(String(reason)))
      }
    } finally {
      this.pumping = false
      if (!this.sources.size) this.state(false)
    }
  }

  stop() {
    if (activeOutputPlayer === this) activeOutputPlayer = null
    this.controller.abort(); this.queue = []
    const prepared=this.prepared;this.prepared=null
    if(prepared)void prepared.created.then(({id})=>speechOutputApi.cancel(id,this.options.projectId??'')).catch(()=>{})
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
function nativeSpeech(text: string, settings: OutputSettings, signal: AbortSignal) {
  const bridge = window.WorkStepSpeech!
  const id = `speech-${Date.now()}-${++speechSequence}`
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: string) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); nativePending.delete(id)
      if (error) reject(new Error(error)); else resolve()
    }
    const abort = () => { bridge.postMessage(JSON.stringify({ type: 'stop', id })); finish() }
    const timer = setTimeout(() => { bridge.postMessage(JSON.stringify({ type: 'stop', id })); finish('系统语音响应超时，请检查手机的文字转语音设置') }, 60000)
    bridge.onmessage = event => {
      try {
        const result = JSON.parse(event.data)
        nativePending.get(result.id)?.(result)
      } catch { /* Ignore unrelated or malformed native messages. */ }
    }
    nativePending.set(id, result => finish(result.status === 'error' ? result.error || '系统语音播放失败' : undefined))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try { bridge.postMessage(JSON.stringify({ type: 'speak', id, text, rate: settings.rate, volume: settings.volume })) }
    catch (error) { finish(error instanceof Error ? error.message : String(error)) }
  })
}
