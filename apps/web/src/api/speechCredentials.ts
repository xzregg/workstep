import { request } from './transport'

export interface SpeechDestination {
  mode: string
  provider: string
  base_url: string
  app_id: string
  region?: string
}

export type SpeechSecret = 'api_key' | 'secret_id' | 'secret_key'
export type SpeechSecrets = Partial<Record<SpeechSecret, string | null> & Record<`has_${SpeechSecret}`, boolean>>

export function speechDestinationKey({ mode, provider, base_url, app_id, region }: SpeechDestination) {
  return JSON.stringify([mode, provider, base_url.trim().replace(/\/+$/, ''), app_id.trim(), region?.trim() ?? ''])
}

export function readSpeechSecret(kind: 'speech' | 'speech-output', destination: SpeechDestination, field: SpeechSecret, signal: AbortSignal) {
  const { mode, provider, base_url, app_id, region } = destination
  return request<{ value: string }>(`/${kind}/settings/secret`, {
    method: 'POST', body: JSON.stringify({ mode, provider, base_url, app_id, region, field }), signal,
  })
}
