import source from './errors/source.json' with { type: 'json' }
import translations from './errors/translations.json' with { type: 'json' }

type ErrorTranslations = Record<string, string>
type LocaleTranslations = Record<string, ErrorTranslations>
type Entry = { key: string; english: string; chinese: string }
type Template = { entry: Entry; parts: string[]; parameters: string[] }
const supportedLanguages = new Map([['ja', 'ja-JP'], ['fr', 'fr-FR'], ['de', 'de-DE'], ['ar', 'ar']])

const exact = new Map<string, Entry>()
const templates: Template[] = []
for (const [id, english, chinese] of source) {
  const entry = { key: `errors.${id}`, english, chinese }
  for (const text of [english, chinese]) {
    if (!/\{p\d+\}/.test(text)) {
      if (!exact.has(text)) exact.set(text, entry)
      continue
    }
    const parts = text.split(/\{p\d+\}/)
    const parameters = Array.from(text.matchAll(/\{(p\d+)\}/g), (match) => match[1])
    if ((parts[0] || parts[parts.length - 1]) && parts.join('').trim().length >= 5 && parts.slice(1, -1).every(Boolean)) {
      templates.push({ entry, parts, parameters })
    }
  }
}
templates.sort((a, b) => b.parts.join('').length - a.parts.join('').length)

function matchTemplate(text: string, { parts, parameters }: Template): ErrorTranslations | undefined {
  const prefix = parts[0]
  const suffix = parts[parts.length - 1]
  if (!text.startsWith(prefix) || !text.endsWith(suffix) || prefix.length + suffix.length > text.length) return
  const end = text.length - suffix.length
  let start = prefix.length
  const values: ErrorTranslations = {}
  for (let index = 0; index < parameters.length; index += 1) {
    const separator = parts[index + 1]
    const stop = index === parameters.length - 1 ? end : text.indexOf(separator, start)
    if (stop < start || stop > end) return
    values[parameters[index]] = text.slice(start, stop)
    start = stop + separator.length
  }
  return values
}

export function translateErrorText(
  text: string,
  locale: string,
  overrides?: Readonly<ErrorTranslations>,
): string {
  const language = locale.toLowerCase()
  const canonical = language.startsWith('zh')
    ? (/^zh-(?:tw|hk|mo|hant)\b/.test(language) ? 'zh-TW' : 'zh-CN')
    : supportedLanguages.get(language.split('-')[0]) ?? 'en-US'
  const translate = ({ key, english, chinese }: Entry) =>
    overrides?.[key] ?? (canonical === 'zh-CN' ? chinese : (translations as LocaleTranslations)[canonical]?.[key] ?? english)
  const entry = exact.get(text)
  if (entry) return translate(entry)
  if (text.length > 4096) return text
  for (const template of templates) {
    const values = matchTemplate(text, template)
    if (values) return translate(template.entry).replace(/\{(p\d+)\}/g, (placeholder, name: string) => values[name] ?? placeholder)
  }
  return text
}
