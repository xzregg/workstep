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
import { initialLang, translate } from '../src/i18n'

const dictionaries = { 'zh-CN': zhCN, 'en-US': enUS, 'fr-FR': frFR, 'de-DE': deDE, ar }

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
  it('all builtins expose identical key sets', () => {
    const zhKeys = flattenKeys(zhCN).sort()
    for (const dict of Object.values(dictionaries)) expect(flattenKeys(dict).sort()).toEqual(zhKeys)
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
    for (const [browser, expected] of [['fr-CA', 'fr-FR'], ['de-AT', 'de-DE'], ['ar-SA', 'ar'], ['en-GB', 'en-US'], ['zh-HK', 'zh-CN'], ['es-ES', 'zh-CN']]) {
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
