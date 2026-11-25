import { useEffect, useRef, useState } from 'react'
import { speechApi } from '../api/speech'
import { voiceprintApi, type VoiceprintStatus } from '../api/voiceprint'
import { modelDownloading } from '../api/speechModelInstall'
import { voiceCapture, pcmBase64, type VoiceCapture } from '../utils/voiceCapture'
import { useI18n, localizeErrorDisplay } from '../i18n'
import Button from './Button'
import Select from './Select'
import ConfirmDialog from './ConfirmDialog'
import VoiceModelDownloadActions, { VoiceModelSavedDownload } from './VoiceModelDownloadActions'
import { formatVoiceModelSize } from './VoiceModelMirror'

interface Recording {
  token: AbortController; kind: 'enroll' | 'test'; frames: Int16Array[]; samples: number
  capture?: VoiceCapture; timer?: ReturnType<typeof setTimeout>; stopping: boolean
}

/** Owns capture, enrollment and verification; audio exists only until submission. */
export default function VoiceprintSettings({ initialStatus, disabled, mirror, onBusyChange }: {
  initialStatus: VoiceprintStatus; disabled: boolean; mirror?: string; onBusyChange?: (busy: boolean) => void
}) {
  const { t } = useI18n()
  const [status, setStatus] = useState(initialStatus)
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'saving'>('idle')
  const [kind, setKind] = useState<Recording['kind']>('enroll')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<'profile' | 'download' | null>(null)
  const alive = useRef(true), recording = useRef<Recording | null>(null)
  const busy = phase !== 'idle'
  const installing = modelDownloading(status.install)
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
  const cancel = () => {
    const run = recording.current; recording.current = null
    if (run) { clearTimeout(run.timer); run.capture?.stop(); run.token.abort(); run.frames = [] }
    if (alive.current) { setPhase('idle'); setSeconds(0) }
  }
  useEffect(() => {
    alive.current = true
    const hide = () => { if (document.hidden) cancel() }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', cancel)
    return () => { alive.current = false; cancel(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', cancel) }
  }, [])
  useEffect(() => {
    if (!installing) return
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = (await speechApi.status()).voiceprint
        if (!stopped && next) setStatus(next)
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : 'speech.failed') }
      if (!stopped) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [installing])
  const mutate = async (operation: () => Promise<VoiceprintStatus>) => {
    setPhase('saving'); setError(''); setMessage('')
    try {
      const next = await operation()
      if (alive.current) { setStatus(next); window.dispatchEvent(new Event('workstep:speech-settings-changed')) }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'speech.failed') }
    finally { if (alive.current) setPhase('idle') }
  }
  const finish = async () => {
    const run = recording.current
    if (!run?.capture || run.stopping) return
    run.stopping = true; clearTimeout(run.timer); setPhase('saving')
    try {
      await run.capture.flush()
      run.capture.stop()
      if (recording.current !== run || run.token.signal.aborted) return
      if (run.samples < (run.kind === 'enroll' ? 96000 : 16000)) throw new Error('voiceprint.needMoreSpeech')
      const samples = new Int16Array(run.samples)
      let offset = 0
      for (const frame of run.frames) { samples.set(frame, offset); offset += frame.length }
      run.frames = []
      const audio = pcmBase64(samples)
      samples.fill(0)
      if (run.kind === 'enroll') {
        const next = await voiceprintApi.enroll(audio, run.token.signal)
        if (recording.current !== run) return
        setStatus(next); setMessage('voiceprint.saved')
        window.dispatchEvent(new Event('workstep:speech-settings-changed'))
      } else {
        const result = await voiceprintApi.test(audio, run.token.signal)
        if (recording.current !== run) return
        setMessage(`voiceprint.${result.speaker_status}`)
      }
    } catch (reason) {
      if (recording.current === run && !run.token.signal.aborted) setError(reason instanceof Error ? reason.message : 'speech.failed')
    } finally { if (recording.current === run) cancel() }
  }
  const start = async (kind: Recording['kind']) => {
    if (disabled || busy || recording.current) return
    setKind(kind); setError(''); setMessage(''); setSeconds(0); setPhase('requesting')
    const run: Recording = { token: new AbortController(), kind, frames: [], samples: 0, stopping: false }
    recording.current = run
    const fail = (key: string) => { if (recording.current === run) { cancel(); setError(key) } }
    run.token.signal.addEventListener('error', () => fail('speech.deviceLost'), { once: true })
    run.token.signal.addEventListener('vaderror', () => fail('speech.vadUnavailable'), { once: true })
    run.timer = setTimeout(() => fail('speech.microphoneTimeout'), 30000)
    try {
      const capture = await voiceCapture.start((samples, _level, turn) => {
        if (recording.current !== run || run.token.signal.aborted || turn && !turn.recentSpeech) return
        const retained = samples.slice(0, 320000 - run.samples)
        if (retained.length) { run.frames.push(retained); run.samples += retained.length; setSeconds(Math.floor(run.samples / 16000)) }
        if (run.samples >= 192000 && !run.stopping) void finish()
      }, run.token.signal, true)
      if (recording.current !== run || run.token.signal.aborted) { capture.stop(); return }
      run.capture = capture
      clearTimeout(run.timer)
      run.timer = setTimeout(() => void finish(), 20000)
      setPhase('recording')
    } catch (reason) {
      if (recording.current === run) { cancel(); setError(reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'speech.permissionDenied' : reason instanceof Error ? reason.message : 'speech.failed') }
    }
  }
  const blocked = disabled || busy || installing
  const localizedError = /^(speech|voiceprint)\./.test(error) ? t(error as Parameters<typeof t>[0]) : localizeErrorDisplay(error)
  return <section className="voiceprint-settings" aria-labelledby="voiceprint-title">
    <h2 id="voiceprint-title">{t('voiceprint.title')}</h2>
    <p>{t('voiceprint.description')}</p>
    <p>{t(status.runtime_available ? 'voiceprint.privacy' : 'voiceprint.runtimeRequired')}</p>
    {!status.available && <div className="speech-model">
      <div className="speech-model-heading"><strong>CAMPPlus</strong><span>{formatVoiceModelSize(status.model_bytes)}</span></div>
      <a href={status.source} target="_blank" rel="noreferrer">{t('voiceprint.source')}</a>
      {installing && <span role="status"><span className="task-status-spinner" />{t('speech.stage_downloading')}</span>}
      {installing && <progress max={status.install.total_bytes || 1} value={status.install.downloaded_bytes} />}
      <VoiceModelSavedDownload install={status.install} />
      <div className="speech-model-actions"><VoiceModelDownloadActions install={status.install} disabled={disabled || busy}
        startDisabled={!status.runtime_available || !mirror || disabled || busy}
        downloadLabel={t('voiceprint.download')}
        onDownload={() => void mutate(() => voiceprintApi.download(mirror))}
        onPause={() => void mutate(voiceprintApi.cancelDownload)} onDiscard={() => setConfirm('download')} /></div>
      {status.install.error && <p role="alert">{t(status.install.error as Parameters<typeof t>[0])}</p>}
    </div>}
    <label className="speech-setting-toggle"><input type="checkbox" checked={status.enabled}
      disabled={blocked || !status.enrolled || !status.available}
      onChange={event => void mutate(() => voiceprintApi.configure(event.target.checked, status.scope))} />{t('voiceprint.enable')}</label>
    <label>{t('voiceprint.scope')}<Select value={status.scope} disabled={blocked || !status.enrolled}
      onChange={event => void mutate(() => voiceprintApi.configure(status.enabled, event.target.value as VoiceprintStatus['scope']))}>
      <option value="calls">{t('voiceprint.calls')}</option><option value="all">{t('voiceprint.all')}</option>
    </Select></label>
    <p>{t(status.enrolled ? 'voiceprint.enrolled' : 'voiceprint.empty')}</p>
    {status.error && <p role="alert">{t(status.error as Parameters<typeof t>[0])}</p>}
    <p>{t('voiceprint.limitations')}</p>
    {phase === 'recording' && <>
      <div className="voiceprint-prompt">
        {kind === 'enroll' ? <>
          <p>{t('voiceprint.promptIntro')}</p>
          <p className="voiceprint-prompt-text">{t('voiceprint.prompt')}</p>
          <p>{t('voiceprint.promptDuration')}</p>
        </> : <p>{t('voiceprint.testPrompt')}</p>}
      </div>
      <span role="status">{t('voiceprint.recording', { seconds })}</span>
      <div className="speech-model-actions">
        <Button onClick={() => void finish()} disabled={seconds < (kind === 'enroll' ? 6 : 1)}>{t(kind === 'enroll' ? 'voiceprint.saveRecording' : 'voiceprint.verifyRecording')}</Button>
        <Button onClick={cancel}>{t('speech.cancel')}</Button>
      </div>
    </>}
    {(phase === 'saving' || phase === 'requesting') && <span role="status"><span className="task-status-spinner" />{t(phase === 'requesting' ? 'speech.requesting' : 'common.loading')}</span>}
    {phase === 'requesting' && <div className="speech-model-actions"><Button onClick={cancel}>{t('speech.cancel')}</Button></div>}
    {phase === 'idle' && <div className="speech-model-actions">
      <Button disabled={blocked || !status.available} onClick={() => void start('enroll')}>{t(status.enrolled ? 'voiceprint.reEnroll' : 'voiceprint.enroll')}</Button>
      <Button disabled={blocked || !status.available || !status.enrolled} onClick={() => void start('test')}>{t('voiceprint.test')}</Button>
      {status.enrolled && <Button disabled={blocked} onClick={() => setConfirm('profile')}>{t('voiceprint.delete')}</Button>}
    </div>}
    {message && <p role="status">{t(message as Parameters<typeof t>[0])}</p>}
    {error && <p role="alert">{localizedError}</p>}
    <ConfirmDialog open={confirm !== null} title={t(confirm === 'download' ? 'voiceModel.discard' : 'voiceprint.delete')}
      message={t(confirm === 'download' ? 'voiceModel.discardConfirm' : 'voiceprint.deleteConfirm')}
      confirmText={t(confirm === 'download' ? 'voiceModel.discard' : 'voiceprint.delete')}
      onCancel={() => setConfirm(null)} onConfirm={() => {
        const target = confirm; setConfirm(null)
        void mutate(target === 'download' ? voiceprintApi.discardDownload : voiceprintApi.delete)
      }} />
  </section>
}
