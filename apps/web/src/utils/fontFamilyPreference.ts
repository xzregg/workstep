export const FONT_FAMILY_STORAGE_KEY = 'workstep.fontFamily'
export const FONT_FAMILY_PREFERENCES = ['system', 'pingfang', 'serif'] as const
export type FontFamilyPreference = typeof FONT_FAMILY_PREFERENCES[number]

interface StorageLike { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }
interface FontTarget { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> }
const defaultStorage = () => typeof window === 'undefined' ? undefined : window.localStorage
const defaultTarget = () => typeof document === 'undefined' ? undefined : document.documentElement
const stacks = {
  pingfang: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  serif: 'Georgia, "Songti SC", "SimSun", serif',
}

export function loadFontFamilyPreference(storage: StorageLike | undefined = defaultStorage()): FontFamilyPreference {
  try {
    const value = storage?.getItem(FONT_FAMILY_STORAGE_KEY)
    return FONT_FAMILY_PREFERENCES.includes(value as FontFamilyPreference) ? value as FontFamilyPreference : 'system'
  } catch { return 'system' }
}

export function applyFontFamilyPreference(value: FontFamilyPreference, target: FontTarget | undefined = defaultTarget()) {
  if (!target) return
  for (const property of ['--font-body', '--font-display']) {
    if (value === 'system') target.style.removeProperty(property)
    else target.style.setProperty(property, stacks[value])
  }
}

export function saveFontFamilyPreference(value: FontFamilyPreference, storage: StorageLike | undefined = defaultStorage(), target: FontTarget | undefined = defaultTarget()) {
  try { storage?.setItem(FONT_FAMILY_STORAGE_KEY, value) } catch { /* Apply even when storage is unavailable. */ }
  applyFontFamilyPreference(value, target)
}

export function initializeFontFamilyPreference() { applyFontFamilyPreference(loadFontFamilyPreference()) }
