import { request } from './transport'
import type { VoiceModelInstall } from './speechModelInstall'

export interface VoiceprintStatus {
  available: boolean; runtime_available: boolean; enrolled: boolean; enabled: boolean
  scope: 'calls' | 'all'; model_bytes: number; source: string; install: VoiceModelInstall; error?: string
}
export type SpeakerStatus = 'matched' | 'unmatched' | 'insufficient'
const write = (method: string, body?: unknown, signal?: AbortSignal): RequestInit => ({
  method, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
export const voiceprintApi = {
  configure: (enabled: boolean, scope: VoiceprintStatus['scope']) => request<VoiceprintStatus>('/speech/voiceprint/settings', write('PUT', { enabled, scope })),
  enroll: (audio: string, signal?: AbortSignal) => request<VoiceprintStatus>('/speech/voiceprint/enroll', write('POST', { audio }, signal)),
  test: (audio: string, signal?: AbortSignal) => request<{ speaker_status: SpeakerStatus }>('/speech/voiceprint/test', write('POST', { audio }, signal)),
  delete: () => request<VoiceprintStatus>('/speech/voiceprint', write('DELETE')),
  download: (mirror?: string) => request<VoiceprintStatus>(`/speech/voiceprint/download${mirror ? '?' + new URLSearchParams({ mirror }) : ''}`, write('POST')),
  cancelDownload: () => request<VoiceprintStatus>('/speech/voiceprint/cancel', write('POST')),
  discardDownload: () => request<VoiceprintStatus>('/speech/voiceprint/download', write('DELETE')),
}
