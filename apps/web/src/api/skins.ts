import { request, BASE, ApiError } from './transport'
import { workspaceCatalogPath } from './workspaceScope'
import { gatewayFetch, gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import type { SkinDocument } from '../skins/contract'

export interface SkinSummary { manifest: SkinDocument['manifest']; revision: string }
export interface SkinWorkspace { project_id: string; project_name: string; session_id: string; created?: boolean; workspace_path: string; package_path: string; prompt: string }
export interface SkinValidation { ok: boolean; skin: SkinDocument; coverage: { overridden: string[]; inherited: string[] }; visual_checked: boolean }
async function documentPath(path: string): Promise<SkinDocument> {
  const scoped = await workspaceCatalogPath(path)
  return prepareSkin(await request<SkinDocument>(scoped), scoped)
}
function prepareSkin(skin: SkinDocument, path = '') {
  const query = path.split('?')[1]
  const prefix = gatewayWorkspacePath()
  let css = skin.css
  if (css && skin.file_base) {
    css = css.replaceAll(`url("${skin.file_base}/`, `url("${prefix}${skin.file_base}/`)
    if (query) css = css.replace(/url\("([^"?]+)"\)/g, (_, url: string) => `url("${url}?${query}")`)
  }
  return { ...skin, css, file_base: skin.file_base ? prefix + skin.file_base + (query ? '?' + query : '') : undefined,
    asset_base: skin.asset_base ? prefix + skin.asset_base + (query ? '?' + query : '') : '' }
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
  saveDraft: async (path: string, expected_revision: string, skin: SkinDocument) => {
    const result = await request<SkinValidation>('/skins/draft', { method: 'POST', body: JSON.stringify({ path, expected_revision, skin }) })
    return { ...result, skin: prepareSkin({ ...result.skin, coverage: result.coverage }) }
  },
  remove: (id: string) => request('/skins/' + encodeURIComponent(id), { method: 'DELETE' }),
  import: async (file: File, replace = false) => prepareSkin(await (await binary('/skins/import?replace=' + replace, { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } })).json() as SkinDocument),
  export: async (id: string) => (await binary('/skins/' + encodeURIComponent(id) + '/export')).blob(),
  onboarding: () => request<SkinWorkspace>('/skins/onboarding', { method: 'POST' }),
}
