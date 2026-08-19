import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enUS } from '../src/i18n/en-US'
import { flattenKeys, resolvePath } from '../src/i18n/keys'
import { zhCN } from '../src/i18n/zh-CN'

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
  it('zh-CN and en-US expose identical key sets', () => {
    const zhKeys = flattenKeys(zhCN).sort()
    const enKeys = flattenKeys(enUS).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('every leaf value is a non-empty string', () => {
    const zhValues = flattenKeys(zhCN).map((key) => resolvePath(zhCN, key))
    const enValues = flattenKeys(enUS).map((key) => resolvePath(enUS, key))
    for (const value of [...zhValues, ...enValues]) {
      expect(value).toBeTruthy()
      expect(typeof value).toBe('string')
    }
  })

  it('resolves nested dot-path keys', () => {
    expect(resolvePath(zhCN, 'hero.ctaPrimary')).toBe('下载 WorkStep')
    expect(resolvePath(enUS, 'hero.ctaPrimary')).toBe('Download WorkStep')
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
