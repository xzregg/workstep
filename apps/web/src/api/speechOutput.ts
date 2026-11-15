import { ApiError, request } from './transport'
import { zhCNT } from '../i18n'
import { workspaceCatalogPath } from './workspaceScope'

export interface OutputSettings {
  mode: 'system' | 'local' | 'cloud' | 'remote'
  provider: string; model_id: string; model: string; base_url: string; voice: string
  rate: number; volume: number; instructions: string; region: string; resource_id: string; app_id: string; engine: string
  api_key?: string | null; secret_id?: string | null; secret_key?: string | null
  has_api_key?: boolean; has_secret_id?: boolean; has_secret_key?: boolean
}
export interface OutputModel {
  id: string; name: string; model_bytes: number; installed: boolean; streaming: 'sentence'
  license_url: string; voices: { id: string; name: string }[]
  runtime?: 'sherpa' | 'qwen'; instructions?: boolean; voice_design?: boolean; requirements?: string
  install: { stage: string; downloaded_bytes: number; total_bytes: number | null; error: string }
}
export interface OutputStatus {
  settings: OutputSettings; models: OutputModel[]; service: 'busy' | 'ready' | 'stopped'
  providers: { id: string; name: string; model: string; voice: string; base_url: string; streaming: boolean; instructions: boolean }[]
}
export interface OutputChunk { audio?: string; format?: 'pcm' | 'wav'; sample_rate?: number; done: boolean; error?: string }
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
export function outputDraft(value: OutputSettings): OutputSettings {
  const { has_api_key: _a, has_secret_id: _b, has_secret_key: _c, ...draft } = value
  return draft
}
export function outputConfigured(value: OutputSettings) {
  if (!Number.isFinite(value.rate) || value.rate < .5 || value.rate > 2 || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) return false
  if (value.mode === 'system') return true
  if (!value.voice.trim()) return false
  if (value.mode === 'local') return true
  const secret = (field: 'api_key' | 'secret_id' | 'secret_key') => value[field] == null ? !!value[`has_${field}`] : !!value[field]?.trim()
  if (value.mode === 'cloud' && (value.provider === 'tencent' ? !secret('secret_id') || !secret('secret_key') : !secret('api_key'))) return false
  if (value.provider === 'tencent' && !/^\d+$/.test(value.voice)) return false
  if (value.provider === 'volcengine' && !value.resource_id.trim()) return false
  if (!['volcengine', 'tencent'].includes(value.provider) && !value.model.trim()) return false
  if (value.mode === 'remote' || value.provider === 'openai') {
    try { const url = new URL(value.base_url); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return false }
    catch { return false }
  }
  return true
}
export const OUTPUT_CHANGED = 'workstep:speech-output-settings-changed'
export const speechOutputApi = {
  status: async (projectId = '') => request<OutputStatus>(await workspaceCatalogPath('/speech-output', projectId)).catch(error => {
    if (error instanceof ApiError && error.status === 404 && error.message === 'Not Found') throw new Error(zhCNT('tts.backendUpdateRequired'))
    throw error
  }),
  save: async (value: OutputSettings) => {
    const result = await request<OutputSettings>('/speech-output/settings', json('PUT', outputDraft(value)))
    window.dispatchEvent(new Event(OUTPUT_CHANGED))
    return result
  },
  modelAction: (action: 'download' | 'cancel' | 'delete' | 'unload', id?: string) =>
    request<OutputStatus>(`/speech-output/models/${action}${id ? '?model_id=' + encodeURIComponent(id) : ''}`, json('POST')),
  voices: (settings: OutputSettings) => request<{ id: string; name: string }[]>('/speech-output/voices', json('POST', outputDraft(settings))),
  start: async (text: string, projectId = '', settings?: OutputSettings) =>
    request<{ id: string }>(await workspaceCatalogPath('/speech-output/sessions', projectId),
      json('POST', { text, ...(settings ? { settings: outputDraft(settings) } : {}) })),
  next: async (id: string, projectId: string, signal: AbortSignal) =>
    request<OutputChunk>(await workspaceCatalogPath(`/speech-output/sessions/${id}/next`, projectId), { ...json('POST'), signal }),
  cancel: async (id: string, projectId: string) =>
    request(await workspaceCatalogPath(`/speech-output/sessions/${id}`, projectId), json('DELETE')),
}
