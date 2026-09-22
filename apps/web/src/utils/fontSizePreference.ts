export const FONT_SIZE_STORAGE_KEY = 'workstep.fontSize'

export const FONT_SIZE_PREFERENCES = ['small', 'standard', 'large', 'extraLarge'] as const

export type FontSizePreference = typeof FONT_SIZE_PREFERENCES[number]

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

interface FontSizeTarget {
  dataset: Record<string, string | undefined>
}

function defaultStorage(): StorageLike | undefined {
  if (typeof window === 'undefined') return undefined
  return window.localStorage
}

function defaultTarget(): FontSizeTarget | undefined {
  if (typeof document === 'undefined') return undefined
  return document.documentElement
}

function isFontSizePreference(value: string | null): value is FontSizePreference {
  return FONT_SIZE_PREFERENCES.includes(value as FontSizePreference)
}

export function loadFontSizePreference(storage = defaultStorage()): FontSizePreference {
  if (!storage) return 'standard'
  try {
    const value = storage.getItem(FONT_SIZE_STORAGE_KEY)
    return isFontSizePreference(value) ? value : 'standard'
  } catch {
    return 'standard'
  }
}

export function applyFontSizePreference(
  value: FontSizePreference,
  target = defaultTarget(),
) {
  if (target) target.dataset.fontSize = value
}

export function saveFontSizePreference(
  value: FontSizePreference,
  storage = defaultStorage(),
  target = defaultTarget(),
) {
  try {
    storage?.setItem(FONT_SIZE_STORAGE_KEY, value)
  } catch {
    // The preference still applies for this session when storage is unavailable.
  }
  applyFontSizePreference(value, target)
}

export function initializeFontSizePreference() {
  applyFontSizePreference(loadFontSizePreference())
}
