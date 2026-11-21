import { ApiError, request } from './transport'
import { zhCNT } from '../i18n'
import { workspaceCatalogPath } from './workspaceScope'
import type { SpeechSecrets } from './speechCredentials'
import type { VoiceModelInstall } from './speechModelInstall'

export interface OutputSettings extends SpeechSecrets {
  mode: 'system' | 'local' | 'cloud' | 'remote'
  provider: string; model_id: string; model: string; base_url: string; voice: string
  rate: number; volume: number; instructions: string; region: string; resource_id: string; app_id: string; engine: string
  reference_id?: string; reference_text?: string
}
export interface OutputModel {
  id: string; name: string; model_bytes: number; installed: boolean; streaming: 'sentence'
  license_url: string; voices: { id: string; name: string }[]
  runtime?: 'sherpa' | 'qwen' | 'moss' | 'cosyvoice3' | 'omnivoice'
  instructions?: boolean; voice_design?: boolean; requirements?: string; availability_error?: string; runtime_missing?: boolean
  persona_runtime_missing?: boolean
  style?: '' | 'instruction' | 'tone'
  design_attributes?: Partial<Record<'gender' | 'age' | 'pitch' | 'style' | 'accent' | 'dialect', Record<string, string>>>
  install: VoiceModelInstall
}
export interface OutputReference { id: string; modified: number; duration: number }
export interface OutputStatus {
  connections?: OutputSettings[]
  references?: OutputReference[]
  settings: OutputSettings; models: OutputModel[]; service: 'busy' | 'ready' | 'stopped'
  providers: { id: string; name: string; model: string; voice: string; base_url: string; streaming: boolean; instructions: boolean }[]
}
export interface OutputChunk { audio?: string; format?: 'pcm' | 'wav'; sample_rate?: number; rate_factor?: number; done: boolean; error?: string; error_code?: 'temporary' | 'authentication' | 'configuration' | 'synthesis' }
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
export function outputDraft(value: OutputSettings): OutputSettings {
  const { has_api_key: _a, has_secret_id: _b, has_secret_key: _c, ...draft } = value
  return draft
}
export const outputLimits = { rate: { min: .5, max: 2 }, volume: { min: 0, max: 1 } } as const
export function outputValueInRange(value: number, bounds: { min: number; max: number }) {
  return Number.isFinite(value) && value >= bounds.min && value <= bounds.max
}
export function outputConfigured(value: OutputSettings) {
  if (!outputValueInRange(value.rate, outputLimits.rate) || !outputValueInRange(value.volume, outputLimits.volume)) return false
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
    if (error instanceof ApiError && error.status === 404 && error.rawMessage === 'Not Found') throw new Error(zhCNT('tts.backendUpdateRequired'))
    throw error
  }),
  save: async (value: OutputSettings) => {
    const result = await request<OutputSettings>('/speech-output/settings', json('PUT', outputDraft(value)))
    window.dispatchEvent(new Event(OUTPUT_CHANGED))
    return result
  },
  modelAction: (action: 'download' | 'cancel' | 'delete' | 'discard' | 'unload', id?: string, mirror?: string) => {
    const query = new URLSearchParams({ ...(id && { model_id: id }), ...(mirror && { mirror }) })
    return request<OutputStatus>(`/speech-output/models/${action}${query.size ? '?' + query : ''}`, json('POST'))
  },
  voices: (settings: OutputSettings) => request<{ id: string; name: string }[]>('/speech-output/voices', json('POST', outputDraft(settings))),
  uploadReference: (file: File) => request<{ id: string; reference?: OutputReference | null }>('/speech-output/reference',
    { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: file }),
  deleteReference: (id: string) => request<{ settings: OutputSettings }>(`/speech-output/reference/${encodeURIComponent(id)}`, json('DELETE')),
  start: async (text: string, projectId = '', settings?: OutputSettings, previewPrompt?: string, digitalSessionId?: string) =>
    request<{ id: string }>(await workspaceCatalogPath('/speech-output/sessions', projectId),
      json('POST', { text, ...(settings ? { settings: outputDraft(settings), ...(previewPrompt && { preview_prompt: previewPrompt }) }
        : digitalSessionId ? { digital_session_id: digitalSessionId } : {}) })),
  next: async (id: string, projectId: string, signal: AbortSignal) =>
    request<OutputChunk>(await workspaceCatalogPath(`/speech-output/sessions/${id}/next`, projectId), { ...json('POST'), signal }),
  cancel: async (id: string, projectId: string) =>
    request(await workspaceCatalogPath(`/speech-output/sessions/${id}`, projectId), json('DELETE')),
}
