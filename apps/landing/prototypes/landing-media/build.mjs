import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = await mkdtemp(path.join(tmpdir(), 'workstep-prototype-media-'))
await build({
  configFile: false, root, publicDir: false, base: './', plugins: [react()],
  // Keep SVG factories intact: the installed minifier miscompiles Lucide tag names.
  build: { minify: false, outDir, emptyOutDir: true, assetsInlineLimit: 8 * 1024 * 1024, cssCodeSplit: false },
})
let html = await readFile(path.join(outDir, 'index.html'), 'utf8')
const script = html.match(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/)
const style = html.match(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)
if (!script || !style) throw new Error('Missing media bundle output')
const javascript = await readFile(path.resolve(outDir, script[1]), 'utf8')
let stylesheet = await readFile(path.resolve(outDir, style[1]), 'utf8')
const brand = await readFile(path.resolve(root, '../../public/brand-mark.svg'))
stylesheet = stylesheet.replace(/url\((['"]?)[^)]*brand-mark\.svg\1\)/g, `url("data:image/svg+xml;base64,${brand.toString('base64')}")`)
html = html.replace(script[0], '').replace(style[0], () => `<style>${stylesheet.replace(/<\/style/gi, '<\\/style')}</style>`)
html = html.replace('</body>', () => `<script>${javascript.replace(/<\/script/gi, '<\\/script')}</script></body>`)
const destination = path.resolve(root, '../../../../ui/DESIGN/landing-prototype-media.html')
await writeFile(destination, html)
console.log(`Original media components exported: ${destination}`)

// Reuse the site's real translations, including complete translated onboarding steps.
const i18nRoot = path.resolve(root, '../../src/i18n')
const i18nEntry = await readFile(path.join(i18nRoot, 'index.tsx'), 'utf8')
const languageArray = i18nEntry.match(/export const supportedLanguages = (\[[\s\S]*?\]) as const/)
if (!languageArray) throw new Error('Missing supported website languages')
const languages = vm.runInNewContext(`(${languageArray[1]})`)
const locales = {}
for (const { locale } of languages) {
  const source = await readFile(path.join(i18nRoot, `${locale}.ts`), 'utf8')
  const dictionarySource = source.replace(/^import type .*\n/gm, '').replace(/export const \w+(?:: I18nDict)?\s*=\s*/, 'globalThis.dictionary = ')
  const context = {}
  vm.runInNewContext(dictionarySource, context)
  const chapters = locale === 'zh-CN' ? [] : JSON.parse(await readFile(path.resolve(root, `../../src/manual/locales/${locale}.json`), 'utf8'))
  locales[locale] = { dictionary: context.dictionary, chapters: chapters.filter(chapter => ['sdk-installation', 'sdk-credentials', 'execution-defaults', 'local-projects', 'first-task'].includes(chapter.id)) }
}
await writeFile(path.resolve(root, '../../../../ui/DESIGN/landing-prototype-locales.js'), `window.WORKSTEP_PROTOTYPE_LOCALES = ${JSON.stringify({ languages, locales })};\n`)
