import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { enUS } from './en-US'
import { resolvePath, type I18nDict } from './keys'
import { zhCN } from './zh-CN'
import { frFR } from './fr-FR'
import { deDE } from './de-DE'
import { ar } from './ar'

export type Lang = 'zh-CN' | 'en-US' | 'fr-FR' | 'de-DE' | 'ar'

const DICTS: Record<Lang, I18nDict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'fr-FR': frFR,
  'de-DE': deDE,
  ar,
}

export function translate(lang: Lang, key: string) { return resolvePath(DICTS[lang], key) }

function storedLanguage() {
  try { return window.localStorage.getItem(STORAGE_KEY) } catch { return null }
}

const STORAGE_KEY = 'workstep-landing-lang'

export function initialLang(stored: string | null = null, browserLanguage = ''): Lang {
  if (stored && Object.hasOwn(DICTS, stored)) return stored as Lang
  const language = browserLanguage.toLowerCase().split('-')[0]
  return language === 'fr' ? 'fr-FR' : language === 'de' ? 'de-DE'
    : language === 'ar' ? 'ar' : language === 'en' ? 'en-US' : 'zh-CN'
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => typeof window === 'undefined' ? 'zh-CN'
    : initialLang(storedLanguage(), window.navigator?.language))

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
    document.title = translate(lang, 'meta.title')
    document.querySelector('meta[name="description"]')?.setAttribute('content', translate(lang, 'meta.description'))
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', translate(lang, 'meta.title'))
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', translate(lang, 'meta.description'))
  }, [lang])

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang: (next: Lang) => {
        setLangState(next)
        try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* Language switching also works without browser storage. */ }
      },
      t: (key: string) => translate(lang, key),
    }),
    [lang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
