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
    : initialLang(window.localStorage.getItem(STORAGE_KEY), window.navigator?.language))

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      setLang: (next: Lang) => {
        setLangState(next)
        window.localStorage.setItem(STORAGE_KEY, next)
      },
      t: (key: string) => resolvePath(DICTS[lang], key),
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
