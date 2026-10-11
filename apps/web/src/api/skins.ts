import { request, BASE, ApiError } from './transport'
import { workspaceCatalogPath } from './workspaceScope'
import { gatewayFetch, gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import type { SkinDocument } from '../skins/contract'

export interface SkinSummary { manifest: SkinDocument['manifest']; revision: string }
export interface SkinValidation { ok: boolean; skin: SkinDocument; coverage: { overridden: string[]; inherited: string[] }; visual_checked: boolean }
async function documentPath(path: string): Promise<SkinDocument> {
  const scoped = await workspaceCatalogPath(path)
  return prepareSkin(await request<SkinDocument>(scoped), scoped)
}
function prepareSkin(skin: SkinDocument, path = '') {
  const query = path.split('?')[1]
  return { ...skin, asset_base: skin.asset_base ? gatewayWorkspacePath() + skin.asset_base + (query ? '?' + query : '') : '' }
}
async function binary(path: string, options?: RequestInit) {
  const res = await gatewayFetch(BASE + path, { ...options, headers: { ...browserActorHeaders(), ...options?.headers } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`, res.status)
  }
  return res
}
export const skinsApi = {
  list: async () => request<SkinSummary[]>(await workspaceCatalogPath('/skins')),
  get: (id: string) => documentPath('/skins/' + encodeURIComponent(id)),
  validate: async (path: string) => {
    const result = await request<SkinValidation>('/skins/validate', { method: 'POST', body: JSON.stringify({ path }) })
    return { ...result, skin: prepareSkin({ ...result.skin, coverage: result.coverage }) }
  },
  register: async (path: string, replace = false) => prepareSkin(await request<SkinDocument>('/skins/register', { method: 'POST', body: JSON.stringify({ path, replace }) })),
  remove: (id: string) => request('/skins/' + encodeURIComponent(id), { method: 'DELETE' }),
  import: async (file: File, replace = false) => prepareSkin(await (await binary('/skins/import?replace=' + replace, { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } })).json() as SkinDocument),
  export: async (id: string) => (await binary('/skins/' + encodeURIComponent(id) + '/export')).blob(),
  onboarding: () => request<{ project_id: string; project_name: string; session_id: string; workspace_path: string; package_path: string; prompt: string }>('/skins/onboarding', { method: 'POST' }),
}
