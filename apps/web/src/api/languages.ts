import { request, BASE, ApiError } from './transport'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import { workspaceCatalogPath } from './workspaceScope'
import type { LanguageDocument, LanguageSummary } from '../i18n/languagePack'
async function binary(path: string, options?: RequestInit) {
 const response=await gatewayFetch(BASE + path, {...options, headers:{...browserActorHeaders(), ...options?.headers}})
 if (!response.ok) { const body=await response.json().catch(() => ({})); throw new ApiError(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`, response.status) }
 return response
}
export const languagesApi = {
 list: async () => request<LanguageSummary[]>(await workspaceCatalogPath('/language-packs')),
 get: async (id: string) => request<LanguageDocument>(await workspaceCatalogPath('/language-packs/' + encodeURIComponent(id))),
 validate: (path: string) => request<{package: LanguageDocument; coverage: NonNullable<LanguageDocument['coverage']>}>('/language-packs/validate', {method:'POST', body:JSON.stringify({path})}),
 register: (path: string, replace = false) => request<LanguageDocument>('/language-packs/register', {method:'POST', body:JSON.stringify({path, replace})}),
 import: async (file: File, replace = false) => (await binary('/language-packs/import?replace=' + replace, {method:'POST', body:file, headers:{'Content-Type':'application/zip'}})).json() as Promise<LanguageDocument>,
 export: async (id: string) => (await binary('/language-packs/' + encodeURIComponent(id) + '/export')).blob(),
 remove: (id: string) => request('/language-packs/' + encodeURIComponent(id), {method:'DELETE'}),
}
