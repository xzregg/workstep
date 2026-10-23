import {
  createContext, useContext, useEffect, useMemo,
  type ReactNode,
} from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { zhCN, type Messages } from './locales/zh-CN'
import { enUS } from './locales/en-US'
import { zhTW } from './locales/zh-TW'
import { jaJP } from './locales/ja-JP'
import { frFR } from './locales/fr-FR'
import { deDE } from './locales/de-DE'
import { ar } from './locales/ar'
import { builtinLocales, validateLanguage, type BuiltinLocale, type LanguageDocument, type LanguageSummary } from './languagePack'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { appearanceStorage, appearanceScope } from '../utils/appearanceStorage'
import './languagePreview.css'

export type Locale = string

/** 把嵌套词典拍平为「点分路径 → 文案」的类型 */
export type FlattenKeys<T, P extends string = ''> = {
  [K in keyof T]: T[K] extends string
    ? `${P}${K & string}`
    : FlattenKeys<T[K], `${P}${K & string}.`>
}[keyof T]

export type TKey = FlattenKeys<Messages>

export type TFunction = (key: TKey, params?: Record<string, string | number>) => string

export function flatten(
  obj: Record<string, unknown>,
  prefix = '',
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[path] = value
    else Object.assign(out, flatten(value as Record<string, unknown>, path))
  }
  return out
}

const ZH_CN_FLAT = flatten(zhCN)

/** 生成 t 函数：当前词典 → zh-CN → 原 key 回退；{name} 占位插值 */
export function createT(dict: Messages): TFunction {
  const flat = flatten(dict)
  return (key, params) => {
    const template = flat[key] ?? ZH_CN_FLAT[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] !== undefined ? String(params[name]) : match,
    )
  }
}

function builtinDictionary(locale: string): Messages {
 return locale === 'en-US' ? enUS : locale === 'zh-TW' ? zhTW : locale === 'ja-JP' ? jaJP
  : locale === 'fr-FR' ? frFR : locale === 'de-DE' ? deDE : locale === 'ar' ? ar : zhCN
}
export function createLanguageT(pack: LanguageDocument): TFunction {
 const fallback = flatten(builtinDictionary(pack.manifest.fallback_locale))
 return (key, params) => {
  const template = pack.messages[key] ?? fallback[key] ?? ZH_CN_FLAT[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] !== undefined ? String(params[name]) : match) : template
 }
}
let cachedLanguage: LanguageDocument | null | undefined
let cachedLocale = ''
let cachedTranslator: TFunction = createT(zhCN)
/** Non-React consumers use the same selected language. */
export const zhCNT: TFunction = (key, params) => {
 const state = useLocaleStore.getState()
 if (cachedLanguage !== state.language || cachedLocale !== state.locale) { cachedLanguage=state.language; cachedLocale=state.locale; cachedTranslator=state.language ? createLanguageT(state.language) : createT(builtinDictionary(state.locale)) }
 return cachedTranslator(key, params)
}
interface LocaleState {
 locale: Locale
 language: LanguageDocument | null
 installed: LanguageSummary[]
 loading: boolean
 error: string
 previous: {locale: Locale; language: LanguageDocument | null} | null
 setLocale: (locale: Locale) => void
 refresh: () => Promise<void>
 previewLanguage: (pack: LanguageDocument) => void
 cancelPreview: () => void
 confirmPreview: () => void
}
let selectionGeneration = 0
let catalogRequest: Promise<void> | null = null

export function resolveInitialLocale(): Locale {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    const lang = navigator.language.toLowerCase()
    if (lang.startsWith('zh')) {
      return /zh-(tw|hk|mo)/.test(lang) ? 'zh-TW' : 'zh-CN'
    }
    if (lang.startsWith('ja')) return 'ja-JP'
    if (lang.startsWith('fr')) return 'fr-FR'
    if (lang.startsWith('de')) return 'de-DE'
    if (lang.startsWith('ar')) return 'ar'
    return 'en-US'
  }
  return 'zh-CN'
}

export const useLocaleStore = create<LocaleState>()(
 persist((set, get) => ({
  locale: resolveInitialLocale(), language: null, installed: [], loading: false, error: '', previous: null,
  setLocale: (choice) => {
   const generation = ++selectionGeneration
   if (builtinLocales.includes(choice as BuiltinLocale)) { set({locale:choice, language:null, previous:null, error:'', loading:false}); return }
   if (!choice.startsWith('pack:')) return
   set({loading:true, error:''})
   void import('../api/languages').then(({languagesApi}) => languagesApi.get(choice.slice(5))).then(validateLanguage).then(language => {
    if (generation === selectionGeneration) set({locale:language.manifest.locale, language, previous:null})
   }).catch(error => { if (generation === selectionGeneration) set({error:String(error.message || error)}) }).finally(() => { if (generation === selectionGeneration) set({loading:false}) })
  },
  refresh: () => {
   if (catalogRequest) return catalogRequest
   set({loading:true, error:''})
   catalogRequest = import('../api/languages').then(({languagesApi}) => languagesApi.list()).then(async installed => {
    set({installed})
    const state = get()
    if (state.language && !state.previous) {
     const current = installed.find(item => item.manifest.id === state.language!.manifest.id)
     if (!current) get().setLocale(state.language.manifest.fallback_locale)
     else if (current.revision !== state.language.revision) get().setLocale('pack:' + current.manifest.id)
    }
   }).catch(error => { set({error:String(error.message || error)}); throw error }).finally(() => { catalogRequest=null; set({loading:false}) })
   return catalogRequest
  },
  previewLanguage: (value) => { const language=validateLanguage(value); ++selectionGeneration; set({locale:language.manifest.locale, language, previous:get().previous ?? {locale:get().locale, language:get().language}, error:'', loading:false}) },
  cancelPreview: () => { const previous=get().previous; if (previous) { ++selectionGeneration; set({...previous, previous:null}) } },
  confirmPreview: () => set({previous:null}),
 }), {
  name:'workstep.locale' + (gatewayWorkspacePath() ? ':' + gatewayWorkspacePath() : ''),
  storage: createJSONStorage(() => appearanceStorage),
  partialize: state => state.previous ?? {locale:state.locale, language:state.language},
  merge: (persisted, current) => {
   let saved = persisted as Partial<LocaleState> | undefined
   if (!saved && gatewayWorkspacePath() && !appearanceScope()) {
    try { const legacy=JSON.parse(localStorage.getItem('workstep.locale') || 'null')?.state; if (builtinLocales.includes(legacy?.locale)) saved={locale:legacy.locale} } catch { /* No legacy preference. */ }
   }
   try {
    if (saved?.language) { const language=validateLanguage(saved.language); return {...current, language, locale:language.manifest.locale} }
    if (builtinLocales.includes(saved?.locale as BuiltinLocale)) return {...current, locale:saved!.locale!}
   } catch { /* Corrupt cache never prevents recovery. */ }
   return !saved && !appearanceScope() ? {...current, locale:resolveInitialLocale(), language:null, previous:null} : current
  },
 }),
)

interface I18nContextValue {
  t: TFunction
  locale: Locale
  setLocale: (locale: Locale) => void
  fallbackLocale: Locale
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const language = useLocaleStore(s => s.language)
  const previous = useLocaleStore(s => s.previous)
  const installed = useLocaleStore(s => s.installed)
  const t = useMemo(() => language ? createLanguageT(language) : createT(builtinDictionary(locale)), [locale, language])
  const fallbackLocale = language?.manifest.fallback_locale ?? locale
  useEffect(() => { if (useLocaleStore.getState().language) void useLocaleStore.getState().refresh().catch(() => {}) }, [])
  useEffect(() => { if (new URLSearchParams(window.location.search).get('language') === 'default') setLocale('zh-CN') }, [setLocale])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo(() => ({ t, locale, setLocale, fallbackLocale }), [t, locale, setLocale, fallbackLocale])
  return <I18nContext.Provider value={value}>{children}{previous && <div className="language-preview-notice" data-skin-recovery role="status"><span>正在预览语言：{language?.manifest.native_name}</span><button type="button" disabled={!installed.some(item => item.manifest.id === language?.manifest.id && item.revision === language.revision)} onClick={() => useLocaleStore.getState().confirmPreview()}>确认使用</button><button type="button" onClick={() => useLocaleStore.getState().cancelPreview()}>取消预览</button><button type="button" onClick={() => setLocale('zh-CN')}>恢复简体中文</button></div>}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
