import { request } from './transport'
export interface DigitalPersonProfile {
  enabled: boolean; name: string; role: string; personality: string; duties: string
  avatar: 'robot' | 'spark'; greeting: string
}
export const digitalPersonApi = {
  get: () => request<DigitalPersonProfile>('/digital-person'),
  save: (profile: DigitalPersonProfile) => request<DigitalPersonProfile>('/digital-person', { method: 'PUT', body: JSON.stringify(profile) }),
}

export interface VoiceWakeDraft { keyword: string; sensitivity: 'low' | 'balanced' | 'high' }
export interface VoiceWakeStatus extends VoiceWakeDraft { available: boolean; listening: boolean }
export const voiceWakeApi = {
  get: () => request<VoiceWakeStatus>('/digital-person/voice-wake'),
  save: (draft: VoiceWakeDraft) => request<VoiceWakeStatus>('/digital-person/voice-wake', { method: 'PUT', body: JSON.stringify(draft) }),
}
