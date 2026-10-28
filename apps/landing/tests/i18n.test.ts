import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enUS } from '../src/i18n/en-US'
import { flattenKeys, resolvePath } from '../src/i18n/keys'
import { zhCN } from '../src/i18n/zh-CN'
import { frFR } from '../src/i18n/fr-FR'
import { deDE } from '../src/i18n/de-DE'
import { ar } from '../src/i18n/ar'
import { initialLang, translate, supportedLanguages, languageDictionaries as dictionaries } from '../src/i18n'


function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walkFiles(full) : [full]
  })
}

function staticTKeys(): string[] {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url))
  const keys = new Set<string>()
  const pattern = /(?<![A-Za-z0-9_$])t\(['"`]([^'"`$]+)['"`]\)/g
  for (const file of walkFiles(srcRoot)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) keys.add(match[1])
  }
  return [...keys]
}

describe('i18n dictionaries', () => {
  it('covers three mainstream Southeast Asian languages and browser detection', () => {
    expect(supportedLanguages.map(item => item.locale)).toEqual(expect.arrayContaining(['vi-VN', 'id-ID', 'th-TH']))
    for (const [browser, expected] of [['th', 'th-TH'], ['th-TH', 'th-TH'], ['vi', 'vi-VN'], ['id', 'id-ID'], ['in-ID', 'id-ID']]) expect(initialLang(null, browser)).toBe(expected)
  })
  it('includes the languages shown in the application selector', () => {
    expect(supportedLanguages.map(item => item.locale)).toEqual(expect.arrayContaining(['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'ar', 'it-IT', 'nl-NL', 'ru-RU', 'pl-PL', 'tr-TR', 'hi-IN', 'id-ID', 'vi-VN', 'es-ES', 'pt-BR', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'cs-CZ', 'el-GR', 'he-IL']))
    for (const { locale } of supportedLanguages) expect(initialLang(locale)).toBe(locale)
  })
  it('all builtins expose identical key sets', () => {
    const zhKeys = flattenKeys(zhCN).sort()
    for (const dict of Object.values(dictionaries)) expect(flattenKeys(dict).sort()).toEqual(zhKeys)
  })

  it('preserves technical file paths in every localized website demo', () => {
    const keys = flattenKeys(enUS).filter(key => /^(?:[\w.-]+\/)+[\w.-]+\.(?:md|tsx?|zip)$/.test(resolvePath(enUS, key)))
    for (const dict of Object.values(dictionaries)) {
      for (const key of keys) expect(resolvePath(dict, key)).toBe(resolvePath(enUS, key))
    }
  })

  it('translates marketing headings and paragraphs rather than keeping English fallbacks', () => {
    const keys = flattenKeys(enUS).filter(key => key.endsWith('.eyebrow') || resolvePath(enUS, key).length > 50)
    for (const [locale, dict] of Object.entries(dictionaries)) {
      if (locale === 'en-US') continue
      for (const key of keys) expect(resolvePath(dict, key), `${locale}: ${key}`).not.toBe(resolvePath(enUS, key))
    }
  })

  it('every leaf value is a non-empty string', () => {
    for (const value of Object.values(dictionaries).flatMap(dict => flattenKeys(dict).map(key => resolvePath(dict, key)))) {
      expect(value).toBeTruthy()
      expect(typeof value).toBe('string')
    }
  })

  it('translates the download action in the new languages', () => {
    expect(frFR.hero.ctaPrimary).toBe('Télécharger l’application')
    expect(deDE.hero.ctaPrimary).toBe('Desktop-App herunterladen')
    expect(ar.hero.ctaPrimary).toBe('تنزيل تطبيق سطح المكتب')
  })

  it('provides localized page metadata, privacy and manual category names', () => {
    for (const lang of ['en-US', 'fr-FR', 'de-DE', 'ar'] as const) {
      for (const key of ['meta.title', 'meta.description', 'privacy.title', 'privacy.localData', 'privacy.externalServices', 'manual.groups.getting-started']) {
        expect(translate(lang, key)).not.toBe(translate('zh-CN', key))
      }
      expect(translate(lang, 'manual.screenshotNotice')).not.toBe('')
    }
  })

  it('restores each saved language and detects browser languages', () => {
    for (const lang of Object.keys(dictionaries)) expect(initialLang(lang, 'en-US')).toBe(lang)
    for (const [browser, expected] of [['fr-CA', 'fr-FR'], ['de-AT', 'de-DE'], ['ar-SA', 'ar'], ['en-GB', 'en-US'], ['zh-HK', 'zh-TW'], ['es-MX', 'es-ES'], ['ja', 'ja-JP'], ['ko', 'ko-KR'], ['no-NO', 'nb-NO'], ['he', 'he-IL'], ['zh-Hant', 'zh-TW'], ['xx', 'zh-CN']]) {
      expect(initialLang(null, browser)).toBe(expected)
      expect(initialLang('invalid', browser)).toBe(expected)
    }
  })

  it('resolves nested dot-path keys', () => {

    expect(resolvePath(enUS, 'hero.ctaPrimary')).toBe('Download desktop app')
    expect(resolvePath(zhCN, 'heroPreview.newProject')).toBe('添加项目')
    expect(resolvePath(enUS, 'heroPreview.newProject')).toBe('Add project')
    expect(resolvePath(zhCN, 'heroPreview.statistics')).toBe('数据统计')
  })

  it('every static t() key used in src exists in both dictionaries', () => {
    const missing = staticTKeys().filter((key) => {
      try {
        resolvePath(zhCN, key)
        resolvePath(enUS, key)
        return false
      } catch {
        return true
      }
    })
    expect(missing).toEqual([])
  })
})
