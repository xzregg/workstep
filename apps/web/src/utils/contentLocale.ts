import { useLocaleStore } from '../i18n'

/** Language packs expose their actual locale, not their UI fallback language. */
export function contentLocale(): string {
  return useLocaleStore.getState().locale
}

export function templateLocale(locale: string): 'zh-CN' | 'en-US' {
  return locale.toLowerCase().split('-')[0] === 'zh' ? 'zh-CN' : 'en-US'
}

export function visibleTemplates<T extends { id?: string; default?: boolean; locale?: string | null }>(templates: T[], locale: string, selectedId?: string): T[] {
  const selected = templateLocale(locale)
  return templates.filter(template => (Boolean(selectedId) && template.id === selectedId) || !template.default || !template.locale || template.locale === selected)
}
