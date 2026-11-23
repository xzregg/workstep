import { voiceWakeApi, type DigitalPersonProfile } from '../api/digitalPerson'
import type { OutputSettings } from '../api/speechOutput'
import { SpeechOutputPlayer, type SpeechAudioChunk } from '../utils/speechOutput'
import { loadSpeechOutputSettings } from '../utils/speechOutputSettings'
import { isAndroidWakeClient, playNativeWakeMedia, playWakeSound } from './wakeSound'

export type WakeGreetingVoice = Pick<DigitalPersonProfile, 'voice_name' | 'voice_rate'>

export type PreparedWakeGreeting = { text: string; settings: OutputSettings; chunks?: SpeechAudioChunk[]; normalized?: boolean }
const androidGreetingGain = 2

export function wakeGreetingOptions(text: string) {
  return [...new Set(text.split(/[|｜]/).map(option => option.trim()).filter(Boolean))]
}

export function chooseWakeGreeting(options: readonly string[]) {
  return options[Math.floor(Math.random() * options.length)] ?? ''
}

export async function loadSavedWakeGreeting(text: string, projectId: string, signal: AbortSignal): Promise<PreparedWakeGreeting[]> {
  const options = wakeGreetingOptions(text)
  const outputSettings = loadSpeechOutputSettings(projectId)
  void outputSettings.catch(() => {})
  for (let attempt = 0; attempt < 65; ++attempt) {
    signal.throwIfAborted()
    const audio = await voiceWakeApi.audio(signal)
    if (audio.text !== text) return []
    if (audio.status === 'system' || audio.status === 'none' || audio.status === 'ready') {
      const current = await outputSettings
      const settings = { ...current, mode: audio.mode ?? current.mode, rate: audio.rate ?? current.rate,
        volume: audio.status === 'none' ? 0 : (audio.volume ?? current.volume) }
      if (audio.status !== 'ready') return options.map(text => ({ text, settings }))
      if (audio.alternatives) return audio.alternatives.filter(item => options.includes(item.text) && item.chunks.length)
        .map(item => ({ ...item, settings, normalized: audio.normalized }))
      return options.length === 1 && options[0] === text && audio.chunks?.length
        ? [{ text, settings, chunks: audio.chunks, normalized: audio.normalized }] : []
    }
    if (audio.status !== 'pending') return []
    await new Promise<void>(resolve => {
      const complete = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', complete)
        resolve()
      }
      const timer = setTimeout(complete, attempt < 5 ? 500 : 2000)
      signal.addEventListener('abort', complete, { once: true })
      if (signal.aborted) complete()
    })
  }
  return []
}

function nativeGreetingChunk(chunk: SpeechAudioChunk, sampleRate: number): string | undefined {
  if (chunk.sampleRate !== sampleRate) return
  if (chunk.format === 'pcm') return chunk.audio
  // The Android bridge accepts mono PCM16. Cached local speech can wrap those same samples in WAV.
  let wav: string
  try { wav = atob(chunk.audio) } catch { return }
  if (wav.length < 12 || wav.slice(0, 4) !== 'RIFF' || wav.slice(8, 12) !== 'WAVE') return
  const bytes = new DataView(Uint8Array.from(wav, byte => byte.charCodeAt(0)).buffer)
  const end = bytes.getUint32(4, true) + 8
  if (end > wav.length) return
  let compatible = false
  for (let offset = 12; offset + 8 <= end;) {
    const tag = wav.slice(offset, offset + 4)
    const length = bytes.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + length > end) return
    if (tag === 'fmt ') {
      compatible = length >= 16 && bytes.getUint16(start, true) === 1
        && bytes.getUint16(start + 2, true) === 1 && bytes.getUint32(start + 4, true) === sampleRate
        && bytes.getUint16(start + 12, true) === 2 && bytes.getUint16(start + 14, true) === 16
    } else if (tag === 'data') {
      return compatible && length > 0 && length % 2 === 0 ? btoa(wav.slice(start, start + length)) : undefined
    }
    offset = start + length + (length % 2)
  }
}

export async function playWakeGreeting(greeting: PreparedWakeGreeting | string,
  projectId: string, voice: WakeGreetingVoice | undefined, signal: AbortSignal) {
  if (signal.aborted) return false
  const android = isAndroidWakeClient()
  const bridge = android && typeof window !== 'undefined' ? window.WorkStepWakeGreeting : undefined
  if (bridge && typeof greeting !== 'string' && greeting.settings.mode !== 'system') {
    const { chunks, settings } = greeting
    if (settings.volume <= 0) return true
    const sampleRate = chunks?.[0]?.sampleRate
    const pcm = sampleRate ? chunks?.map(chunk => nativeGreetingChunk(chunk, sampleRate)) : undefined
    if (sampleRate && pcm?.every(chunk => chunk !== undefined)) {
      const release = SpeechOutputPlayer.reserveNativeWakePlayback()
      try {
        const result = await playNativeWakeMedia(bridge, {
          type: 'wake-greeting', chunks: pcm, sampleRate,
          volume: settings.volume, rate: voice?.voice_rate ?? settings.rate,
        }, signal)
        if (result !== 'unavailable' || signal.aborted) return result === 'finished'
      } finally { release() }
    }
  }
  return new Promise<boolean>(resolve => {
    let player: SpeechOutputPlayer | undefined
    let finished = false
    let started = false
    let handoff: ReturnType<typeof setTimeout> | undefined
    const finish = (played = false) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(handoff)
      signal.removeEventListener('abort', abort)
      player?.stop()
      resolve(played)
    }
    const abort = () => finish()
    let timer = setTimeout(abort, typeof greeting === 'string' ? 8000 : 2500)
    signal.addEventListener('abort', abort, { once: true })
    const play = ({ text, settings, chunks, normalized }: PreparedWakeGreeting) => {
      if (finished) return
      if (settings.volume <= 0) { finish(true); return }
      player = new SpeechOutputPlayer({
        projectId, settings: { ...settings, rate: voice?.voice_rate ?? settings.rate,
          volume: android && settings.mode === 'system' ? Math.min(1, settings.volume * androidGreetingGain) : settings.volume },
        systemVoice: voice?.voice_name,
        wakeGreeting: true,
        audioGain: android && !normalized ? androidGreetingGain : undefined,
        // Open the output route with audio samples before the first audible word.
        leadingSilence: android ? .24 : undefined,
        cachedAudio: chunks ? { text, chunks } : undefined,
        onPlayback: playing => {
          if (!playing || started || finished) return
          started = true
          clearTimeout(timer)
          timer = setTimeout(abort, 30000)
        },
        onState: active => { if (!active) queueMicrotask(() => finish(true)) },
        onError: abort,
        onInterrupt: abort,
      })
      // Android may still be leaving the capture route when the detector releases the mic.
      if (android) {
        void player.unlock().catch(() => {})
        handoff = setTimeout(() => player?.enqueue([text]), 180)
      } else player.enqueue([text])
    }
    if (typeof greeting === 'string') {
      void loadSpeechOutputSettings(projectId).then(settings => play({ text: greeting, settings })).catch(abort)
    } else {
      try { play(greeting) } catch { abort() }
    }
  })
}

export async function previewWakeSound(text: string, projectId: string, voice: WakeGreetingVoice | undefined,
  chime: HTMLAudioElement | null, signal: AbortSignal) {
  const selected = chooseWakeGreeting(wakeGreetingOptions(text))
  if (selected) return playWakeGreeting(selected, projectId, voice, signal)
  return playWakeSound(chime, signal)
}
