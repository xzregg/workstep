import { useEffect, useRef, useState } from 'react'
import { voiceCapture, type VoiceCapture } from '../utils/voiceCapture'

const SAMPLE_RATE = 16000
const MAX_SECONDS = 30
const MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS

type Recording = {
  controller: AbortController
  samples: Int16Array
  length: number
  capture?: VoiceCapture
  timer?: ReturnType<typeof setTimeout>
  finishing: boolean
}

function stopRecording(recording: Recording) {
  clearTimeout(recording.timer)
  recording.controller.abort()
}

function toWav(samples: Int16Array, length: number) {
  const bytes = new DataView(new ArrayBuffer(44 + length * 2))
  bytes.setUint32(0, 0x52494646) // RIFF
  bytes.setUint32(4, bytes.byteLength - 8, true)
  bytes.setUint32(8, 0x57415645) // WAVE
  bytes.setUint32(12, 0x666d7420) // fmt
  bytes.setUint32(16, 16, true)
  bytes.setUint16(20, 1, true) // PCM
  bytes.setUint16(22, 1, true) // mono
  bytes.setUint32(24, SAMPLE_RATE, true)
  bytes.setUint32(28, SAMPLE_RATE * 2, true)
  bytes.setUint16(32, 2, true)
  bytes.setUint16(34, 16, true)
  bytes.setUint32(36, 0x64617461) // data
  bytes.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) bytes.setInt16(44 + i * 2, samples[i], true)
  return new File([bytes.buffer], 'reference.wav', { type: 'audio/wav' })
}

export function useReferenceRecording(sourceKey: string | undefined, onRecorded: (file: File) => Promise<void>, onError: (message: string) => void) {
  const current = useRef<Recording | null>(null)
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'recording' | 'finishing'>('idle')

  useEffect(() => {
    setPhase('idle')
    return () => {
      const recording = current.current
      current.current = null
      if (recording) stopRecording(recording)
    }
  }, [sourceKey])

  const cancel = () => {
    const recording = current.current
    current.current = null
    if (recording) stopRecording(recording)
    setPhase('idle')
  }

  const finish = async () => {
    const recording = current.current
    if (!recording?.capture || recording.finishing) return
    recording.finishing = true
    setPhase('finishing')
    try {
      await recording.capture.flush()
      if (current.current !== recording) return
      if (recording.length < SAMPLE_RATE / 2) {
        onError('tts.referenceRecordingShort')
        return
      }
      stopRecording(recording)
      await onRecorded(toWav(recording.samples, recording.length))
    } catch (reason) {
      if (current.current === recording) onError(reason instanceof Error ? reason.message : 'speech.failed')
    } finally {
      if (current.current === recording) cancel()
    }
  }

  const start = async () => {
    if (!sourceKey || current.current) return
    const recording: Recording = {
      controller: new AbortController(), samples: new Int16Array(MAX_SAMPLES), length: 0, finishing: false,
    }
    current.current = recording
    onError('')
    setPhase('requesting')
    const { signal } = recording.controller
    signal.addEventListener('error', () => {
      if (current.current !== recording) return
      cancel()
      onError('speech.audioSourceUnavailable')
    }, { once: true })
    try {
      recording.capture = await voiceCapture.start(pcm => {
        if (current.current !== recording) return
        const chunk = pcm.subarray(0, MAX_SAMPLES - recording.length)
        recording.samples.set(chunk, recording.length)
        recording.length += chunk.length
        if (recording.length === MAX_SAMPLES) void finish()
      }, signal)
      if (current.current !== recording) {
        recording.capture.stop()
        return
      }
      setPhase('recording')
      recording.timer = setTimeout(() => void finish(), MAX_SECONDS * 1000)
    } catch (reason) {
      if (current.current !== recording) return
      cancel()
      onError(reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'speech.permissionDenied'
        : reason instanceof Error ? reason.message : 'speech.failed')
    }
  }

  return { phase, start, finish, cancel }
}
