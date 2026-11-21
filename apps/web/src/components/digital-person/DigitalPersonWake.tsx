import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { VOICE_WAKE_CHANGED, voiceWakeApi, type VoiceWakeDraft } from '../../api/digitalPerson'
import { OUTPUT_CHANGED } from '../../api/speechOutput'
import { useSpeechEnabled } from '../../hooks/useSpeechEnabled'
import { useI18n } from '../../i18n'
import { voiceCapture } from '../../utils/voiceCapture'
import { isGatewayRemoteBrowser } from '../../utils/gatewayRemote'
import { loadSavedWakeGreeting, playWakeGreeting, previewWakeSound, type PreparedWakeGreeting, type WakeGreetingVoice } from '../../audio/wakeGreeting'
import { isAndroidWakeClient, playWakeSound, prepareWakeSound } from '../../audio/wakeSound'
import { primeSpeechOutput } from '../../utils/speechOutput'
import { invalidateSpeechOutputSettings } from '../../utils/speechOutputSettings'
import Button from '../Button'
import Spinner from '../Spinner'
import { getWakeEnabled, getWakeTest, setWakeTest, subscribeWakeEnabled,
  subscribeWakeTest, useWakeEnabled, useWakeTest } from './wakePreferences'

export const wakeWordRuntime = { load: () => import('../../audio/wakeWord') }
const testDuration = 10000
const frameSamples = 1280

type Status = { phase: 'preparing' | 'listening' | 'failure' | 'matched' | 'unmatched'; detail?: string }
type WakeConfig = VoiceWakeDraft & { sound_enabled?: boolean; greeting?: string }
type WakeDetector = Awaited<ReturnType<typeof import('../../audio/wakeWord').openWakeWord>>
export interface WakeControls { releaseMicrophone: () => void }

export default function DigitalPersonWake({ projectId = '', blocked, playback = false, speakerMuted = false, voice, onWake, onListeningChange, ref, draft }: {
  projectId?: string; blocked: boolean; playback?: boolean; onWake?: () => void; ref?: Ref<WakeControls>
  onListeningChange?: (listening: boolean) => void
  draft?: VoiceWakeDraft & { soundEnabled?: boolean; greeting?: string }; speakerMuted?: boolean; voice?: WakeGreetingVoice
}) {
  const { t } = useI18n()
  const settings = draft !== undefined
  const warmTrial = settings && isAndroidWakeClient()
  const preload = !warmTrial && !isGatewayRemoteBrowser()
  const ready = useSpeechEnabled(projectId, !settings)
  const enabled = useWakeEnabled()
  const [owner] = useState(() => Symbol('wake test'))
  const testingOwner = useWakeTest()
  const test = testingOwner === owner
  const [visible, setVisible] = useState(() => !document.hidden)
  const [cooling, setCooling] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [revision, refresh] = useState(0)
  const [configVersion, updateConfig] = useState(0)
  const latestWake = useRef(onWake)
  latestWake.current = onWake
  const latestOutput = useRef({ speakerMuted, voice })
  latestOutput.current = { speakerMuted, voice }
  const chime = useRef<HTMLAudioElement | null>(null)
  const warmDetector = useRef<{ config: Promise<WakeConfig>; ready: Promise<WakeDetector>; close: () => void } | null>(null)
  const prepareChime = !settings && enabled && ready
  useEffect(() => {
    chime.current = prepareChime ? prepareWakeSound() : null
    return () => { chime.current = null }
  }, [prepareChime])
  const abort = useRef<AbortController | null>(null)
  useImperativeHandle(ref, () => ({
    releaseMicrophone() {
      abort.current?.abort()
      setWakeTest(owner, false)
    },
  }), [owner])
  const automatic = !settings && enabled && ready && !testingOwner
  const unavailable = blocked || playback || cooling
  const shouldListen = visible && !unavailable && (test || automatic)
  const keyword = draft?.keyword
  const sensitivity = draft?.sensitivity
  const warmAutomatic = !settings && enabled
  useEffect(() => {
    if (!visible) return
    const draftConfig = warmTrial && keyword && keyword.trim().length >= 2 && sensitivity
      ? { keyword, sensitivity } : null
    if (!draftConfig && !warmAutomatic) return
    const controller = new AbortController()
    const { signal } = controller
    const config = draftConfig ? Promise.resolve(draftConfig) : voiceWakeApi.get()
    const runtime = wakeWordRuntime.load()
    if (warmAutomatic && !preload) void runtime.then(value => value.preloadWakeWord()).catch(() => {})
    const slot = {
      config,
      close: () => controller.abort(),
      ready: Promise.all([config, runtime]).then(([value, runtime]) => {
        signal.throwIfAborted()
        return runtime.openWakeWord(value, signal)
      }),
    }
    warmDetector.current = slot
    void slot.ready.catch(() => {
      if (warmDetector.current === slot) warmDetector.current = null
    })
    return () => {
      if (warmDetector.current === slot) warmDetector.current = null
      controller.abort()
    }
  }, [warmTrial, warmAutomatic, visible, keyword, sensitivity, projectId, configVersion, preload])
  useEffect(() => {
    if (draft) setStatus(null)
  }, [draft])
  useEffect(() => {
    if (unavailable) setWakeTest(owner, false)
  }, [owner, unavailable])
  useEffect(() => {
    if (playback) { setCooling(true); return }
    if (!cooling) return
    const timer = setTimeout(() => setCooling(false), 600)
    return () => clearTimeout(timer)
  }, [playback, cooling])
  useEffect(() => {
    if (preload) void wakeWordRuntime.load().then(runtime => runtime.preloadWakeWord()).catch(() => {})
    const stopOnTest = subscribeWakeTest(() => {
      if (getWakeTest() && getWakeTest() !== owner) abort.current?.abort()
    })
    const stopOnDisable = subscribeWakeEnabled(() => {
      if (getWakeEnabled()) return
      abort.current?.abort()
      setWakeTest(owner, false)
    })
    const visibility = () => {
      if (document.hidden) {
        abort.current?.abort()
        setWakeTest(owner, false)
      }
      setVisible(!document.hidden)
    }
    const changed = () => { abort.current?.abort(); refresh(value => value + 1) }
    const outputChanged = (event: Event) => { invalidateSpeechOutputSettings(event); changed() }
    document.addEventListener('visibilitychange', visibility)
    const wakeChanged = () => { updateConfig(value => value + 1); changed() }
    window.addEventListener(VOICE_WAKE_CHANGED, wakeChanged)
    if (!settings) window.addEventListener(OUTPUT_CHANGED, outputChanged)
    return () => {
      abort.current?.abort()
      stopOnTest()
      stopOnDisable()
      setWakeTest(owner, false)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener(VOICE_WAKE_CHANGED, wakeChanged)
      window.removeEventListener(OUTPUT_CHANGED, outputChanged)
    }
  }, [owner, preload, settings])
  useEffect(() => {
    if (!shouldListen) return
    const controller = new AbortController()
    abort.current = controller
    const { signal } = controller
    let timer = setTimeout(() => fail('voiceWake.loadFailed'), 45000)
    let pending = 0
    let match: ((samples: Int16Array) => Promise<boolean>) | undefined
    let soundEnabled = true
    let preparedGreeting: PreparedWakeGreeting | null = null
    function fail(detail: string) {
      if (signal.aborted) return
      clearTimeout(timer)
      controller.abort()
      setWakeTest(owner, false)
      setStatus({ phase: 'failure', detail })
    }
    signal.addEventListener('error', () => fail('speech.deviceLost'), { once: true })
    setStatus({ phase: 'preparing' })
    // Open capture in the enabling interaction, before waiting for downloads.
    // Some browsers suspend a Web Audio context created after the gesture.
    const capture = voiceCapture.start(pcm => {
      if (!match || signal.aborted) return
      if (pending >= 4) { fail('voiceWake.loadFailed'); return }
      pending++
      void match(pcm).then(async matched => {
        if (!matched || signal.aborted) return
        clearTimeout(timer)
        controller.abort()
        if (test) {
          setStatus({ phase: 'matched' })
          if (!draft?.soundEnabled) {
            setWakeTest(owner, false)
            return
          }
          const transition = new AbortController()
          abort.current = transition
          const played = await previewWakeSound(draft.greeting?.trim() ?? '', projectId, latestOutput.current.voice, chime.current, transition.signal)
          if (!transition.signal.aborted) {
            if (!played) setStatus({ phase: 'matched', detail: 'tts.failed' })
            setWakeTest(owner, false)
          }
        } else {
          setStatus(null)
          const output = latestOutput.current
          if (output.speakerMuted || !soundEnabled) {
            latestWake.current?.()
            return
          }
          const transition = new AbortController()
          abort.current = transition
          const played = preparedGreeting && await playWakeGreeting(preparedGreeting, projectId, output.voice, transition.signal)
          if (!played) await playWakeSound(chime.current, transition.signal).catch(() => {})
          if (!transition.signal.aborted) latestWake.current?.()
        }
      }).catch(() => fail('voiceWake.loadFailed')).finally(() => { pending-- })
    }, signal, false, frameSamples)
    const slot = warmDetector.current
    const configRequest = (slot?.config ?? (draft
      ? Promise.resolve<WakeConfig>({ keyword: draft.keyword, sensitivity: draft.sensitivity })
      : voiceWakeApi.get())).then(config => {
        if (test) return config
        soundEnabled = config.sound_enabled ?? true
        if (!signal.aborted && soundEnabled && config.greeting) {
          void loadSavedWakeGreeting(config.greeting, projectId, signal).then(value => {
            if (!signal.aborted) preparedGreeting = value
          }).catch(() => {})
        }
        return config
      })
    const detector = Promise.all([configRequest, slot ? null : wakeWordRuntime.load()])
      .then(async ([config, runtime]) => {
        if (slot) {
          try {
            const detector = await slot.ready
            signal.throwIfAborted()
            // Reset audio history so a new trial cannot match the previous utterance.
            await detector.reset()
            return { config, detector }
          } catch {
            signal.throwIfAborted()
            if (warmDetector.current === slot) warmDetector.current = null
            slot.close()
          }
        }
        const { openWakeWord } = runtime ?? await wakeWordRuntime.load()
        signal.throwIfAborted()
        const detector = await openWakeWord(config, signal)
        if (signal.aborted) { detector.close(); signal.throwIfAborted() }
        signal.addEventListener('abort', detector.close, { once: true })
        return { config, detector }
      })
    void Promise.all([capture, detector])
      .then(([capture, { config, detector }]) => {
        if (signal.aborted) { capture.stop(); return }
        match = detector.matches
        clearTimeout(timer)
        setStatus({ phase: 'listening', detail: config.keyword })
        if (!test && onListeningChange) {
          signal.addEventListener('abort', () => onListeningChange(false), { once: true })
          onListeningChange(true)
        }
        if (test) timer = setTimeout(() => {
          controller.abort()
          setWakeTest(owner, false)
          setStatus({ phase: 'unmatched' })
        }, testDuration)
      }).catch(reason => {
        const message = reason instanceof Error ? reason.message : ''
        fail(reason instanceof DOMException && reason.name === 'NotAllowedError'
          ? 'speech.permissionDenied'
          : /^(speech|voiceWake)\.[A-Za-z]+$/.test(message) ? message : 'voiceWake.loadFailed')
      })
    return () => { clearTimeout(timer); abort.current?.abort(); abort.current = null }
  }, [shouldListen, test, revision, projectId, draft, owner, onListeningChange])

  const startTest = () => {
    if (draft?.soundEnabled) {
      primeSpeechOutput()
      chime.current = prepareWakeSound()
    }
    setStatus(null)
    setWakeTest(owner, true)
  }
  const cancelTest = () => {
    abort.current?.abort()
    setStatus(null)
    setWakeTest(owner, false)
  }
  if (!settings) return null
  const phase = status?.phase
  const working = shouldListen && (phase === 'listening' || phase === 'preparing')
  return <div className="voice-wake-test">
    {working && <span role="status">{phase === 'preparing' ? <><Spinner />{t('voiceWake.preparing')}</> :
      t('voiceWake.sayKeyword', { keyword: status?.detail ?? '' })}</span>}
    {phase === 'failure' && <span role="alert">{t(status?.detail as never)}</span>}
    {phase === 'matched' && <span role="status">{t('voiceWake.matched')}</span>}
    {status?.phase === 'matched' && status.detail && <span role="alert">{t(status.detail as never)}</span>}
    {phase === 'unmatched' && <span role="status">{t('voiceWake.unmatched')}</span>}
    {phase === 'failure' && shouldListen && <Button size="sm" onClick={() => refresh(value => value + 1)}>{t('common.retry')}</Button>}
    {test ? <Button onClick={cancelTest}>{t('common.cancel')}</Button> :
      <Button data-test-wake disabled={unavailable || !!testingOwner} onClick={startTest}>{t('voiceWake.test')}</Button>}
  </div>
}
