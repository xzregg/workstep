import { voiceWakeApi, type DigitalPersonProfile } from '../api/digitalPerson'
import type { OutputSettings } from '../api/speechOutput'
import { SpeechOutputPlayer, type SpeechAudioChunk } from '../utils/speechOutput'
import { loadSpeechOutputSettings } from '../utils/speechOutputSettings'
import { isAndroidWakeClient, playWakeSound } from './wakeSound'

export type WakeGreetingVoice = Pick<DigitalPersonProfile, 'voice_name' | 'voice_rate'>

export type PreparedWakeGreeting = { text: string; settings: OutputSettings; chunks?: SpeechAudioChunk[] }
const androidGreetingGain = 2

export async function loadSavedWakeGreeting(text: string, projectId: string, signal: AbortSignal): Promise<PreparedWakeGreeting | null> {
  const outputSettings = loadSpeechOutputSettings(projectId)
  void outputSettings.catch(() => {})
  for (let attempt = 0; attempt < 65; ++attempt) {
    signal.throwIfAborted()
    const audio = await voiceWakeApi.audio(signal)
    if (audio.text !== text) return null
    if (audio.status === 'system' || audio.status === 'none' || (audio.status === 'ready' && audio.chunks?.length)) {
      const current = await outputSettings
      const settings = { ...current, mode: audio.mode ?? current.mode, rate: audio.rate ?? current.rate,
        volume: audio.status === 'none' ? 0 : (audio.volume ?? current.volume) }
      return { text, settings, chunks: audio.chunks }
    }
    if (audio.status !== 'pending') return null
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
  return null
}

export function playWakeGreeting(greeting: PreparedWakeGreeting | string,
  projectId: string, voice: WakeGreetingVoice | undefined, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve(false)
  const android = isAndroidWakeClient()
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
    const play = ({ text, settings, chunks }: PreparedWakeGreeting) => {
      if (finished) return
      if (settings.volume <= 0) { finish(true); return }
      player = new SpeechOutputPlayer({
        projectId, settings: { ...settings, rate: voice?.voice_rate ?? settings.rate,
          volume: android && settings.mode === 'system' ? Math.min(1, settings.volume * androidGreetingGain) : settings.volume },
        systemVoice: voice?.voice_name,
        audioGain: android ? androidGreetingGain : undefined,
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
  if (text) return playWakeGreeting(text, projectId, voice, signal)
  return playWakeSound(chime, signal)
}
