import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { enUS } from './en-US'
import { resolvePath, type I18nDict } from './keys'
import { zhCN } from './zh-CN'

export type Lang = 'zh-CN' | 'en-US'

const DICTS: Record<Lang, I18nDict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

const STORAGE_KEY = 'workstep-landing-lang'

function initialLang(): Lang {
  if (typeof window === 'undefined') return 'zh-CN'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return stored === 'en-US' ? 'en-US' : 'zh-CN'
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

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
