import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { resolvePath, type I18nDict } from './keys'
import { zhCN } from './zh-CN'
import { zhTW } from './zh-TW'
import { enUS } from './en-US'
import { jaJP } from './ja-JP'
import { koKR } from './ko-KR'
import { frFR } from './fr-FR'
import { deDE } from './de-DE'
import { itIT } from './it-IT'
import { nlNL } from './nl-NL'
import { ruRU } from './ru-RU'
import { plPL } from './pl-PL'
import { trTR } from './tr-TR'
import { hiIN } from './hi-IN'
import { idID } from './id-ID'
import { viVN } from './vi-VN'
import { ar } from './ar'

import { esES } from './es-ES'
import { ptBR } from './pt-BR'
import { svSE } from './sv-SE'
import { daDK } from './da-DK'
import { nbNO } from './nb-NO'
import { fiFI } from './fi-FI'
import { csCZ } from './cs-CZ'
import { elGR } from './el-GR'
import { heIL } from './he-IL'

import { thTH } from './th-TH'

export const supportedLanguages = [
  { locale: 'zh-CN', label: '简体中文' },
  { locale: 'zh-TW', label: '繁體中文' },
  { locale: 'en-US', label: 'English' },
  { locale: 'ja-JP', label: '日本語' },
  { locale: 'ko-KR', label: '한국어' },
  { locale: 'fr-FR', label: 'Français' },
  { locale: 'de-DE', label: 'Deutsch' },
  { locale: 'it-IT', label: 'Italiano' },
  { locale: 'nl-NL', label: 'Nederlands' },
  { locale: 'ru-RU', label: 'Русский' },
  { locale: 'pl-PL', label: 'Polski' },
  { locale: 'tr-TR', label: 'Türkçe' },
  { locale: 'hi-IN', label: 'हिन्दी' },
  { locale: 'id-ID', label: 'Bahasa Indonesia' },
  { locale: 'vi-VN', label: 'Tiếng Việt' },
  { locale: 'th-TH', label: 'ไทย' },
  { locale: 'es-ES', label: 'Español' },
  { locale: 'pt-BR', label: 'Português' },
  { locale: 'sv-SE', label: 'Svenska' },
  { locale: 'da-DK', label: 'Dansk' },
  { locale: 'nb-NO', label: 'Norsk bokmål' },
  { locale: 'fi-FI', label: 'Suomi' },
  { locale: 'cs-CZ', label: 'Čeština' },
  { locale: 'el-GR', label: 'Ελληνικά' },
  { locale: 'he-IL', label: 'עברית' },
  { locale: 'ar', label: 'العربية' },
] as const
export type Lang = typeof supportedLanguages[number]['locale']

export const languageDictionaries: Record<Lang, I18nDict> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'fr-FR': frFR,
  'de-DE': deDE,
  'it-IT': itIT,
  'nl-NL': nlNL,
  'ru-RU': ruRU,
  'pl-PL': plPL,
  'tr-TR': trTR,
  'hi-IN': hiIN,
  'id-ID': idID,
  'vi-VN': viVN,
  'th-TH': thTH,
  'es-ES': esES,
  'pt-BR': ptBR,
  'sv-SE': svSE,
  'da-DK': daDK,
  'nb-NO': nbNO,
  'fi-FI': fiFI,
  'cs-CZ': csCZ,
  'el-GR': elGR,
  'he-IL': heIL,
  'ar': ar,
}

export function languageDirection(lang: Lang) { return lang === 'ar' || lang === 'he-IL' ? 'rtl' : 'ltr' }

export function translate(lang: Lang, key: string) { return resolvePath(languageDictionaries[lang], key) }

function storedLanguage() {
  try { return window.localStorage.getItem(STORAGE_KEY) } catch { return null }
}

const STORAGE_KEY = 'workstep-landing-lang'

export function initialLang(stored: string | null = null, browserLanguage = ''): Lang {
  if (stored && Object.hasOwn(languageDictionaries, stored)) return stored as Lang
  const normalized = browserLanguage.toLowerCase()
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(normalized)) return 'zh-TW'
  const language = normalized.split('-')[0]
  if (language === 'in') return 'id-ID'
  if (language === 'no') return 'nb-NO'
  if (language === 'iw') return 'he-IL'
  return supportedLanguages.find(item => item.locale.split('-')[0] === language)?.locale ?? 'zh-CN'
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
    document.documentElement.dir = languageDirection(lang)
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
