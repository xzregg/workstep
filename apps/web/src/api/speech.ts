import { ApiError, request } from './transport'
import { workspaceCatalogPath } from './workspaceScope'

export interface SpeechConnection {
  mode: 'local' | 'cloud' | 'remote'; provider: 'tencent' | 'volcengine' | 'openai'
  base_url: string; model: string; resource_id: string; app_id: string
  api_key?: string | null; secret_id?: string | null; secret_key?: string | null
  has_api_key?: boolean; has_secret_id?: boolean; has_secret_key?: boolean
}
export const defaultSpeechConnection: SpeechConnection = { mode: 'local', provider: 'tencent', base_url: '', model: '16k_zh', resource_id: 'volc.seedasr.sauc.duration', app_id: '' }
export function speechConnectionReady(value: SpeechConnection) {
  if (value.mode === 'local') return true
  const secret = (key: 'api_key' | 'secret_id' | 'secret_key') => value[key] == null ? !!value[`has_${key}`] : !!value[key]?.trim()
  if (!value.model.trim()) return false
  if (value.provider === 'openai') {
    try { const url = new URL(value.base_url); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return false }
    catch { return false }
  }
  if (value.mode === 'cloud') {
    if (value.provider === 'tencent') return /^\d+$/.test(value.app_id) && secret('secret_id') && secret('secret_key') && /^(16k_[A-Za-z0-9_-]+|Hy-ASR-3\.0-preview)$/.test(value.model)
    if (!secret('api_key')) return false
    if (value.provider === 'volcengine' && !value.resource_id.trim()) return false
  }
  return true
}

export interface SpeechStatus {
  connection?: SpeechConnection; ready?: boolean; streaming?: 'native' | 'final'
  enabled: boolean
  language: string
  model_id: string
  service: 'busy' | 'ready' | 'stopped'
  languages: string[]
  models: { id: string; name: string; license: string; license_url: string; model_bytes: number; installed: boolean; punctuation?: boolean; streaming: string;
    install: { stage: string; downloaded_bytes: number; total_bytes: number | null; error: string } }[]
}
export interface SpeechResult { id: string; sequence: number; text: string; final: boolean; processing_ms?: number }
const options = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
}
export const speechApi = {
  status: async (projectId = '') => request<SpeechStatus>(await workspaceCatalogPath('/speech', projectId)),
  configure: (enabled: boolean, language: string, model_id?: string, connection?: SpeechConnection) => request<SpeechStatus>('/speech/settings', options('PUT', { enabled, language, model_id, ...(connection ? { connection } : {}) })).then(result => {
    window.dispatchEvent(new Event('workstep:speech-settings-changed'))
    return result
  }),
  download: (modelId?: string) => request<SpeechStatus>('/speech/models/download' + (modelId ? `?model_id=${encodeURIComponent(modelId)}` : ''), options('POST')),
  cancelDownload: () => request<SpeechStatus>('/speech/models/cancel', options('POST')),
  deleteModel: (modelId?: string) => request<SpeechStatus>('/speech/models/current' + (modelId ? `?model_id=${encodeURIComponent(modelId)}` : ''), options('DELETE')),
  start: async (projectId: string, signal?: AbortSignal) => {
    checkCancelled(signal)
    const path = await workspaceCatalogPath('/speech/sessions', projectId)
    checkCancelled(signal)
    // Aborting a creation request can lose its ID after the server commits it.
    // Always collect that response, then remove a session whose gesture ended.
    const session = await request<{ id: string; sample_rate: number; max_seconds: number; max_frame_samples?: number }>(path, options('POST')).catch(error => {
      // This wording exists only in the retired single-recording daemon.
      // Never cancel an unknown session: it may belong to another user.
      if (error instanceof ApiError && error.status === 409 && error.message === '已有录音正在进行') {
        throw new Error('speech.backendUpdateRequired')
      }
      throw error
    })
    if (signal?.aborted) {
      await request(await workspaceCatalogPath(`/speech/sessions/${session.id}`, projectId), options('DELETE'))
      checkCancelled(signal)
    }
    return session
  },
  audio: async (id: string, projectId: string, sequence: number, audio: string, final: boolean, signal?: AbortSignal) =>
    request<SpeechResult>(await workspaceCatalogPath(`/speech/sessions/${id}/audio`, projectId), {
      ...options('POST', { sequence, audio, final }), signal,
    }),
  cancel: async (id: string, projectId: string) =>
    request(await workspaceCatalogPath(`/speech/sessions/${id}`, projectId), options('DELETE')),
}

export function openSpeechSettings() {
  window.dispatchEvent(new CustomEvent('workstep:open-speech-settings'))
}
