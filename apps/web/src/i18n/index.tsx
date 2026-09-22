import {
  createContext, useContext, useEffect, useMemo,
  type ReactNode,
} from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { zhCN, type Messages } from './locales/zh-CN'
import { enUS } from './locales/en-US'
import { zhTW } from './locales/zh-TW'
import { jaJP } from './locales/ja-JP'

export type Locale = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP'

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

/** 默认（中文）t，供非 React 工具层兜底 */
export const zhCNT: TFunction = createT(zhCN)

interface LocaleState {
  locale: Locale
  setLocale: (locale: Locale) => void
}

function resolveInitialLocale(): Locale {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    const lang = navigator.language.toLowerCase()
    if (lang.startsWith('zh')) {
      return /zh-(tw|hk|mo)/.test(lang) ? 'zh-TW' : 'zh-CN'
    }
    if (lang.startsWith('ja')) return 'ja-JP'
    return 'en-US'
  }
  return 'zh-CN'
}

export const useLocaleStore = create<LocaleState>()(
  persist(
    (set) => ({
      locale: resolveInitialLocale(),
      setLocale: (locale) => set({ locale }),
    }),
    { name: 'workstep.locale' },
  ),
)

interface I18nContextValue {
  t: TFunction
  locale: Locale
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const t = useMemo(() => createT(
    locale === 'en-US' ? enUS
      : locale === 'zh-TW' ? zhTW
        : locale === 'ja-JP' ? jaJP
          : zhCN,
  ), [locale])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo(() => ({ t, locale, setLocale }), [t, locale, setLocale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
