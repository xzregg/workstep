export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'workstep-landing-theme'

export function resolveTheme(storedTheme: string | null, prefersDark: boolean): Theme {
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
  return prefersDark ? 'dark' : 'light'
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'light' ? 'dark' : 'light'
}

export function initialTheme(): Theme {
  if (typeof document === 'undefined') return 'light'

  const documentTheme = document.documentElement.dataset.theme
  if (documentTheme === 'light' || documentTheme === 'dark') return documentTheme

  let storedTheme: string | null = null
  try {
    storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }

  return resolveTheme(storedTheme, window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The active page still switches even when persistence is unavailable.
  }
}
