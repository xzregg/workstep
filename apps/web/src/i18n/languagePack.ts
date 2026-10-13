import catalog from '../../../daemon/data/languages/catalog.json' with { type: 'json' }
export const languageCatalog = catalog as {revision: string; required_keys: string[]; messages: Record<string, string>}
export const builtinLocales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP'] as const
export type BuiltinLocale = typeof builtinLocales[number]
export interface LanguageManifest { schema_version: number; id: string; locale: string; name: string; native_name: string; version: string; fallback_locale: BuiltinLocale; direction: 'ltr'; catalog_revision: string }
export interface LanguageDocument { manifest: LanguageManifest; messages: Record<string, string>; revision: string; coverage?: {total: number; translated: number; missing: string[]} }
export type LanguageSummary = Pick<LanguageDocument, 'manifest' | 'revision' | 'coverage'>
function placeholders(value: string) { return [...value.matchAll(/\{(\w+)\}/g)].map(item => item[1]).sort().join('|') }
export function validateLanguage(value: unknown): LanguageDocument {
 const pack = value as LanguageDocument
 const m = pack?.manifest
 if (!m || m.schema_version !== 1 || m.direction !== 'ltr' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.id) || !/^[a-f0-9]{64}$/.test(pack.revision) || !m.name?.trim() || !m.native_name?.trim() || !m.version?.trim() || !builtinLocales.includes(m.fallback_locale) || builtinLocales.some(locale => locale.toLowerCase() === m.locale?.toLowerCase())) throw new Error('语言包元数据无效')
 try { if (Intl.getCanonicalLocales(m.locale).length !== 1) throw new Error() } catch { throw new Error('语言标识无效') }
 if (!pack.messages || typeof pack.messages !== 'object' || Array.isArray(pack.messages) || languageCatalog.required_keys.some(key => !pack.messages[key])) throw new Error('语言包缺少必要文案')
 for (const [key, text] of Object.entries(pack.messages)) {
  if (!Object.hasOwn(languageCatalog.messages, key) || typeof text !== 'string' || !text.trim() || text.length > 20000 || /<[!/A-Za-z][^>]*>/.test(text) || placeholders(text) !== placeholders(languageCatalog.messages[key])) throw new Error('语言文案或占位符无效：' + key)
 }
 return pack
}
