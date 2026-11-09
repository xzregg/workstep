import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { speechApi, type SpeechResult } from '../api/speech'
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
  value: string; cursor: number; onInsert: (text: string, cursor: number) => void
}
interface Run {
  id?: string; project: string; token: AbortController; capture?: VoiceCapture;
  queue: Int16Array[]; pumping: boolean; sequence: number; text: string;
  finishing: boolean; finalizing: boolean; seconds: number; cursor: number; draft: string
}
export function useVoiceInput(options: Options) {
  const [mode, setMode] = useState(false)
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const run = useRef<Run | null>(null)
  const latest = useRef(options); latest.current = options
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const touchTarget = useRef<HTMLElement | null>(null)
  const heldRecording = useRef(false)
  const clearHold = () => { if (hold.current) clearTimeout(hold.current.timer); hold.current = null; touchTarget.current = null }
  const live = (r: Run) => run.current === r && !r.token.signal.aborted
  const dispose = (r: Run) => {
    r.capture?.stop(); r.token.abort(); r.queue = []
    if (r.id) void speechApi.cancel(r.id, r.project).catch(() => {})
  }
  const cancel = () => {
    heldRecording.current = false
    const r = run.current; run.current = null
    if (r) dispose(r)
    clearHold(); setPhase('idle'); setText(''); setError(''); setLevel(0); setSeconds(0)
  }
  const fail = (r: Run, reason: unknown) => {
    if (!live(r)) return
    setError(reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'speech.permissionDenied'
      : reason instanceof Error ? reason.message : 'speech.failed')
    setPhase('error'); setLevel(0); dispose(r)
    // Keep only recognized text for explicit recovery; no audio survives.
    setText(r.text)
  }
  const commit = (r: Run) => {
    if (!live(r)) return
    if (latest.current.value !== r.draft) { fail(r, new Error('speech.draftChanged')); return }
    latest.current.onInsert(r.text, r.cursor)
    run.current = null; r.capture?.stop(); r.token.abort(); r.queue = []
    setPhase('idle'); setMode(false); setText(''); setLevel(0)
  }
  const submit = async (r: Run, samples: Int16Array, final: boolean) => {
    const sequence = r.sequence++
    const result: SpeechResult = await withDeadline(speechApi.audio(r.id!, r.project, sequence, pcmBase64(samples), final, r.token.signal),
      20000, 'speech.serviceTimeout', r.token.signal)
    if (!live(r)) return
    if (result.id !== r.id || result.sequence !== sequence || result.final !== final) throw new Error('speech.responseMismatch')
    r.text = result.text; setText(result.text)
    if (result.final) commit(r)
  }
  const pump = async (r: Run) => {
    if (r.pumping || !r.id || !live(r)) return
    r.pumping = true
    try {
      while (live(r) && !r.finalizing && (r.queue.length || r.finishing)) {
        // Catch up with the latest audio in one request rather than replaying
        // every outdated half-second hypothesis after a slow decode.
        const batch: Int16Array[] = []
        let length = 0
        while (r.queue.length && length + r.queue[0].length <= 32000) {
          const frame = r.queue.shift()!; batch.push(frame); length += frame.length
        }
        const samples = new Int16Array(length)
        let offset = 0
        for (const frame of batch) { samples.set(frame, offset); offset += frame.length }
        const final = r.finishing && r.queue.length === 0
        if (final) r.finalizing = true
        await submit(r, samples, final)
      }
    } catch (reason) { fail(r, reason) }
    finally { r.pumping = false }
  }
  const finish = () => {
    const r = run.current
    if (!r || !live(r) || r.finishing || !r.capture) return
    r.finishing = true; setPhase('finishing'); setLevel(0)
    r.capture.flush(); r.capture.stop()
    // Pipeline the last small frame while the preview response is travelling
    // back. The server orders it behind that decode, saving one network RTT.
    const length = r.queue.reduce((count, frame) => count + frame.length, 0)
    if (r.pumping && !r.finalizing && r.id && length <= 32000) {
      r.finalizing = true
      const samples = new Int16Array(length)
      let offset = 0
      for (const frame of r.queue) { samples.set(frame, offset); offset += frame.length }
      r.queue = []
      void submit(r, samples, true).catch(reason => fail(r, reason))
    } else void pump(r)
  }
  const start = async () => {
    if (latest.current.disabled || (run.current && live(run.current))) return
    setMode(true); setPhase('requesting'); setError(''); setText(''); setSeconds(0)
    const r: Run = { project: latest.current.projectId ?? '', token: new AbortController(), queue: [],
      pumping: false, sequence: 0, text: '', finishing: false, finalizing: false, seconds: 0,
      cursor: latest.current.cursor, draft: latest.current.value }
    run.current = r
    r.token.signal.addEventListener('error', () => fail(r, new Error('speech.deviceLost')), { once: true })
    try {
      // Capture starts in the gesture; retain a bounded preparation buffer so
      // the opening words survive server readiness and cold-start latency.
      const capturing = voiceCapture.start((samples, volume) => {
        if (!live(r)) return
        samples = samples.subarray(0, Math.max(0, Math.round((120 - r.seconds) * 16000)))
        if (!samples.length) return
        r.seconds += samples.length / 16000; setSeconds(Math.floor(r.seconds)); setLevel(volume)
        if (r.queue.reduce((count, frame) => count + frame.length, 0) + samples.length > 64000) {
          fail(r, new Error('speech.tooSlow')); return
        }
        r.queue.push(samples); void pump(r)
        if (r.seconds >= 120 && !r.finishing) finish()
      }, r.token.signal)
      // Native permission prompts cannot be aborted on every platform.
      // Stop a late stream even if the UI has timed out or moved elsewhere.
      void capturing.then(capture => { if (!live(r)) capture.stop() }, () => {})
      r.capture = await withDeadline(capturing, 30000, 'speech.microphoneTimeout', r.token.signal)
      if (!live(r)) { r.capture.stop(); return }
      setPhase('preparing')
      const creating = speechApi.start(r.project, r.token.signal)
      void creating.then(session => {
        if (!live(r)) void speechApi.cancel(session.id, r.project).catch(() => {})
      }, () => {})
      const session = await withDeadline(creating, 15000, 'speech.serviceTimeout', r.token.signal)
      if (!live(r)) { void speechApi.cancel(session.id, r.project).catch(() => {}); return }
      r.id = session.id
      setPhase(r.finishing ? 'finishing' : 'recording')
      void pump(r)
    } catch (reason) { fail(r, reason) }
  }
  const releaseHold = () => {
    clearHold()
    if (!heldRecording.current) return
    heldRecording.current = false
    const r = run.current
    // Captured audio remains valid even if session creation has not returned.
    // Stop the microphone now; the eventual session drains the retained audio.
    if (r?.capture && live(r)) finish()
    else if (r && live(r)) cancel()
    setMode(false)
  }
  const cancelHold = () => {
    clearHold()
    if (!heldRecording.current) return
    cancel(); setMode(false)
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
    window.addEventListener('touchcancel', cancelHold)
    window.addEventListener('touchmove', touchMove, { passive: false })
    return () => {
      window.removeEventListener('pointerup', releaseHold)
      window.removeEventListener('pointercancel', pointerCancelled)
      window.removeEventListener('touchend', touchEnd)
      window.removeEventListener('touchcancel', cancelHold)
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
    mode, phase, text, error, level, seconds, active: ['requesting', 'preparing', 'recording', 'finishing'].includes(phase),
    setMode, start, finish, cancel,
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
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          clearHold(); heldRecording.current = true; void start()
        }, 500) }
      },
      onPointerMove: (e: PointerEvent) => {
        if (hold.current && Math.hypot(e.clientX-hold.current.x, e.clientY-hold.current.y) > 10) clearHold()
      },
      onPointerUp: () => {
        const target = hold.current ? touchTarget.current : null
        releaseHold()
        const input = target?.tagName === 'TEXTAREA' ? target : target?.querySelector<HTMLElement>('textarea')
        input?.focus({ preventScroll: true })
      },
      onPointerCancel: pointerCancelled,
      onContextMenu: (e: { preventDefault: () => void }) => { if (options.compact) e.preventDefault() },
    },
  }
}
