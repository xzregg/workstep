import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { speechApi, type SpeechResult, type SpeechStreaming } from '../api/speech'
import type { TurnState } from '../audio/turnController'
import { browserDiagnostics } from '../utils/browserDiagnostics'
import { voiceCapture, pcmBase64, type VoiceCapture } from '../utils/voiceCapture'

export type VoicePhase = 'idle' | 'requesting' | 'preparing' | 'recording' | 'finishing' | 'error'
function withDeadline<T>(work: Promise<T>, milliseconds: number, message: string, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)) }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}
interface Options {
  ownerKey: string; projectId?: string; disabled: boolean; compact: boolean;
  value: string; cursor: number; automatic?: boolean; showLevel?: boolean; onInsert: (text: string, cursor: number) => void
}
interface Run {
  turn?: TurnState; id?: string; project: string; token: AbortController; capture?: VoiceCapture;
  opening: boolean; streaming?: SpeechStreaming; candidateAt?: number; checking: boolean;
  queue: Int16Array[]; queued: number; pumping: boolean; sequence: number; text: string; nextMeterAt: number;
  finishing: boolean; draining: boolean; finalizing: boolean; maxFrameSamples: number; capturedSamples: number; cursor: number; draft: string
}
const SAMPLE_RATE = 16000
const RECORDING_LIMIT = 120 * SAMPLE_RATE

export function useVoiceInput(options: Options) {
  const [mode, setMode] = useState(false)
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [catchingUp, setCatchingUp] = useState(false)
  const run = useRef<Run | null>(null)
  const latest = useRef(options); latest.current = options
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const touchTarget = useRef<HTMLElement | null>(null)
  const heldRecording = useRef(false)
  const heldPointer = useRef<number | undefined>(undefined)
  const clearHold = () => { if (hold.current) clearTimeout(hold.current.timer); hold.current = null; touchTarget.current = null }
  const live = (r: Run) => run.current === r && !r.token.signal.aborted
  const dispose = (r: Run) => {
    r.capture?.stop(); r.token.abort(); r.queue = []
    if (r.id) void speechApi.cancel(r.id, r.project).catch(() => {})
  }
  const cancel = () => {
    heldRecording.current = false; heldPointer.current = undefined
    const r = run.current; run.current = null
    if (r) dispose(r)
    clearHold(); setPhase('idle'); setText(''); setError(''); setNotice(''); setLevel(0); setSeconds(0); setCatchingUp(false)
  }
  const fail = (r: Run, reason: unknown) => {
    if (!live(r)) return
    setError(reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'speech.permissionDenied'
      : reason instanceof Error ? reason.message : 'speech.failed')
    setPhase('error'); setLevel(0); setCatchingUp(false); dispose(r)
    // Keep only recognized text for explicit recovery; no audio survives.
    setText(r.text)
  }
  const commit = (r: Run) => {
    if (!live(r)) return
    if (latest.current.value !== r.draft) { fail(r, new Error('speech.draftChanged')); return }
    latest.current.onInsert(r.text, r.cursor)
    run.current = null; r.capture?.stop(); r.token.abort(); r.queue = []
    setPhase('idle'); setMode(false); setText(''); setNotice(''); setLevel(0); setCatchingUp(false)
  }
  const submit = async (r: Run, samples: Int16Array, final: boolean, preview = true, candidateAt?: number) => {
    const sequence = r.sequence++
    const sentAt = performance.now()
    const result: SpeechResult = await withDeadline(speechApi.audio(r.id!, r.project, sequence, pcmBase64(samples), final, r.token.signal, preview),
      20000, 'speech.serviceTimeout', r.token.signal)
    if (!live(r)) return
    if (result.id !== r.id || result.sequence !== sequence || result.final !== final) throw new Error('speech.responseMismatch')
    const requestMs = performance.now() - sentAt
    const queuedMs = r.queued / 16
    if (requestMs >= 1000 || queuedMs >= 2000) {
      browserDiagnostics.recordSpeechTiming({ requestMs, processingMs: result.processing_ms, queuedMs })
    }
    if (candidateAt !== undefined && candidateAt !== r.turn?.lastVoice) return
    if (preview) { r.text = result.text; setText(result.text) }
    if (result.final) commit(r)
  }
  const pump = async (r: Run) => {
    if (r.pumping || r.draining || !r.id || !live(r)) return
    r.pumping = true
    try {
      while (live(r) && !r.draining && !r.finalizing && (r.queue.length || r.finishing)) {
        const candidate = r.streaming === 'segment' && r.turn?.candidate && r.candidateAt !== r.turn.lastVoice
        const buffered = r.streaming === 'segment' || r.streaming === 'final'
        const minimum = buffered ? r.maxFrameSamples : r.turn ? 8000 : 1
        if (!r.finishing && !candidate && r.queued < minimum) break
        // Catch up with the latest audio in one request rather than replaying
        // every outdated half-second hypothesis after a slow decode.
        const batch: Int16Array[] = []
        let length = 0
        while (r.queue.length && length + r.queue[0].length <= r.maxFrameSamples) {
          const frame = r.queue.shift()!; batch.push(frame); length += frame.length
        }
        r.queued -= length
        setCatchingUp(r.queued >= 32000 && r.streaming !== 'segment' && r.streaming !== 'final')
        const samples = new Int16Array(length)
        let offset = 0
        for (const frame of batch) { samples.set(frame, offset); offset += frame.length }
        const final = r.finishing && r.queue.length === 0
        if (final) r.finalizing = true
        const candidateAt = !final && candidate && !r.queue.length ? r.turn?.lastVoice : undefined
        if (candidateAt !== undefined) r.candidateAt = candidateAt
        await submit(r, samples, final, r.streaming !== 'segment' || final || candidateAt !== undefined, candidateAt)
      }
    } catch (reason) { fail(r, reason) }
    finally { r.pumping = false }
  }
  const finish = async (automatic = false) => {
    const r = run.current
    if (!r || !live(r) || r.finishing || r.checking || !r.capture) return
    if (r.turn && !r.turn.hasSpeech) { cancel(); return }
    r.checking = true
    if (!automatic) { r.finishing = true; r.draining = true; setPhase('finishing'); setLevel(0) }
    try {
      const turn = await r.capture.flush()
      if (!live(r)) return
      if (r.turn && !turn) throw new Error('speech.vadUnavailable')
      if (turn) r.turn = turn
      if (automatic && r.turn && !r.turn.canCommit && r.capturedSamples < RECORDING_LIMIT) {
        if (r.candidateAt !== r.turn.lastVoice) { r.text = ''; setText('') }
        return
      }
      // The checkpoint includes all PCM posted before the worklet's flush ack.
      // If SenseVoice decoded this same speech, only unvoiced tail remains.
      if (automatic && r.streaming === 'segment' && r.turn?.canCommit && r.candidateAt === r.turn.lastVoice) {
        r.queue = []; r.queued = 0; setCatchingUp(false)
      }
      r.finishing = true; setPhase('finishing'); setLevel(0)
    }
    catch (reason) { fail(r, reason); return }
    finally { r.checking = false }
    if (!live(r)) return
    r.capture.stop(); r.draining = false
    // Pipeline the last small frame while the preview response is travelling
    // back. The server orders it behind that decode, saving one network RTT.
    const length = r.queued
    if (r.pumping && !r.finalizing && r.id && length <= r.maxFrameSamples) {
      r.finalizing = true
      const samples = new Int16Array(length)
      let offset = 0
      for (const frame of r.queue) { samples.set(frame, offset); offset += frame.length }
      r.queue = []; r.queued = 0; setCatchingUp(false)
      void submit(r, samples, true).catch(reason => fail(r, reason))
    } else void pump(r)
  }
  const openSession = async (r: Run) => {
    if (r.opening || !r.capture || !live(r) || r.turn && !r.turn.hasSpeech) return
    r.opening = true
    setPhase(r.finishing ? 'finishing' : 'preparing')
    try {
      const creating = speechApi.start(r.project, r.token.signal)
      void creating.then(session => {
        if (!live(r)) void speechApi.cancel(session.id, r.project).catch(() => {})
      }, () => {})
      const session = await withDeadline(creating, 15000, 'speech.serviceTimeout', r.token.signal)
      if (!live(r)) { void speechApi.cancel(session.id, r.project).catch(() => {}); return }
      r.id = session.id
      r.streaming = session.streaming
      r.maxFrameSamples = Math.max(32000, Math.min(128000, session.max_frame_samples ?? 32000))
      setPhase(r.finishing ? 'finishing' : 'recording')
      void pump(r)
    } catch (reason) { fail(r, reason) }
  }
  const start = async () => {
    if (latest.current.disabled || (run.current && live(run.current))) return
    setMode(true); setPhase('requesting'); setError(''); setNotice(''); setText(''); setSeconds(0); setCatchingUp(false)
    const r: Run = { turn: latest.current.automatic ? { lastVoice: 0, hasSpeech: false, canCommit: false, candidate: false } : undefined,
      project: latest.current.projectId ?? '', token: new AbortController(), queue: [], queued: 0, opening: false, checking: false, nextMeterAt: 0,
      pumping: false, sequence: 0, text: '', finishing: false, draining: false, finalizing: false,
      maxFrameSamples: 32000, capturedSamples: 0,
      cursor: latest.current.cursor, draft: latest.current.value }
    run.current = r
    r.token.signal.addEventListener('error', () => {
      if (!live(r) || r.finishing) return
      if (!r.turn && r.capture && r.capturedSamples > 0) {
        heldRecording.current = false; heldPointer.current = undefined
        setMode(false); setNotice('speech.interrupted'); void finish()
      } else fail(r, new Error('speech.deviceLost'))
    }, { once: true })
    r.token.signal.addEventListener('vaderror', () => fail(r, new Error('speech.vadUnavailable')), { once: true })
    try {
      // Capture starts in the gesture; retain a bounded preparation buffer so
      // the opening words survive server readiness and cold-start latency.
      const capturing = voiceCapture.start((samples, volume, turn) => {
        if (!live(r)) return
        samples = samples.subarray(0, RECORDING_LIMIT - r.capturedSamples)
        if (!samples.length) return
        r.capturedSamples += samples.length
        if (r.capturedSamples >= r.nextMeterAt) {
          r.nextMeterAt = r.capturedSamples + 560
          setSeconds(Math.floor(r.capturedSamples / SAMPLE_RATE))
          if (latest.current.showLevel !== false) setLevel(volume)
        }
        // The recording limit bounds total PCM to 3.84 MB. Keep delayed audio
        // through temporary network stalls instead of discarding it at 4s.
        r.queue.push(samples); r.queued += samples.length
        if (r.turn && turn) {
          const lastVoice = r.turn.lastVoice
          r.turn = turn
          if (r.candidateAt === lastVoice && r.turn.lastVoice !== lastVoice) { r.text = ''; setText('') }
          if (!r.turn.hasSpeech) {
            // 320 ms before onset plus up to 96 ms while confirming it.
            const keep = 16 * (320 + 96)
            while (r.queued > keep) {
              const first = r.queue[0], excess = r.queued - keep
              if (first.length <= excess) { r.queue.shift(); r.queued -= first.length }
              else { r.queue[0] = first.subarray(excess); r.queued = keep }
            }
            if (r.capturedSamples === RECORDING_LIMIT) cancel()
            return
          }
          void openSession(r)
          if (r.turn.canCommit) void finish(true)
        }
        setCatchingUp(r.queued >= 32000 && r.streaming !== 'segment' && r.streaming !== 'final')
        void pump(r)
        if (r.capturedSamples === RECORDING_LIMIT && !r.finishing) void finish()
      }, r.token.signal, Boolean(r.turn))
      // Native permission prompts cannot be aborted on every platform.
      // Stop a late stream even if the UI has timed out or moved elsewhere.
      void capturing.then(capture => { if (!live(r)) capture.stop() }, () => {})
      r.capture = await withDeadline(capturing, 30000, 'speech.microphoneTimeout', r.token.signal)
      if (!live(r)) { r.capture.stop(); return }
      if (r.turn) setPhase('recording')
      await openSession(r)
    } catch (reason) { fail(r, reason) }
  }
  const releaseHold = (event?: { pointerId?: number }) => {
    if (heldPointer.current !== undefined && event?.pointerId !== undefined && event.pointerId !== heldPointer.current) return
    clearHold()
    if (!heldRecording.current) return
    heldRecording.current = false; heldPointer.current = undefined
    const r = run.current
    // Captured audio remains valid even if session creation has not returned.
    // Stop the microphone now; the eventual session drains the retained audio.
    if (r?.capture && live(r)) finish()
    else if (r && live(r)) cancel()
    setMode(false)
  }
  // A browser pan cancels pointer events even while the finger is still down.
  // Once activated, use the physical touch end/cancel to settle the recording.
  const pointerCancelled = () => { if (!heldRecording.current) clearHold() }
  useEffect(() => {
    const touchEnd = (e: TouchEvent) => { if (!e.touches?.length) releaseHold() }
    const touchMove = (e: TouchEvent) => { if (heldRecording.current && e.cancelable) e.preventDefault() }
    window.addEventListener('pointerup', releaseHold)
    window.addEventListener('pointercancel', pointerCancelled)
    window.addEventListener('touchend', touchEnd)
    window.addEventListener('touchcancel', touchEnd)
    window.addEventListener('touchmove', touchMove, { passive: false })
    return () => {
      window.removeEventListener('pointerup', releaseHold)
      window.removeEventListener('pointercancel', pointerCancelled)
      window.removeEventListener('touchend', touchEnd)
      window.removeEventListener('touchcancel', touchEnd)
      window.removeEventListener('touchmove', touchMove)
    }
  }, [])
  useEffect(() => {
    return () => { const r = run.current; run.current = null; if (r) dispose(r); clearHold() }
  }, [options.ownerKey])
  useEffect(() => {
    cancel(); setMode(false)
    // Ownership/permissions changes invalidate pending audio and late output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.ownerKey, options.disabled])
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel() }
    const leave = () => cancel()
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', leave)
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave) }
  }, [])
  return {
    mode, phase, text, error, notice, level: options.showLevel === false ? 0 : level, seconds, catchingUp, active: ['requesting', 'preparing', 'recording', 'finishing'].includes(phase),
    get hasSpeech() { return run.current?.turn?.hasSpeech ?? false },
    setMode, start, finish: () => finish(), cancel,
    recover: () => {
      const r = run.current
      if (r && r.draft === latest.current.value && r.text) latest.current.onInsert(r.text, r.cursor)
      cancel(); setMode(false)
    },
    pointer: {
      onPointerDown: (e: PointerEvent) => {
        clearHold()
        if (!options.compact || options.disabled || (run.current && live(run.current)) || e.pointerType !== 'touch') return
        // Keep normal taps/caret placement native; the context-menu handler
        // below gives a sustained hold to voice mode instead of the text menu.
        touchTarget.current = e.target instanceof HTMLElement ? e.target : null
        hold.current = { x: e.clientX, y: e.clientY, timer: setTimeout(() => {
          clearHold(); heldPointer.current = e.pointerId
          heldRecording.current = true; void start()
        }, 500) }
      },
      onPointerMove: (e: PointerEvent) => {
        if (hold.current && Math.hypot(e.clientX-hold.current.x, e.clientY-hold.current.y) > 10) clearHold()
      },
      onPointerUp: (e: PointerEvent) => {
        const target = hold.current ? touchTarget.current : null
        releaseHold(e)
        const input = target?.tagName === 'TEXTAREA' ? target : target?.querySelector<HTMLElement>('textarea')
        input?.focus({ preventScroll: true })
      },
      onPointerCancel: pointerCancelled,
      onContextMenu: (e: { preventDefault: () => void }) => { if (options.compact) e.preventDefault() },
    },
  }
}
