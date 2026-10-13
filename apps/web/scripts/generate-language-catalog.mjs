import ts from 'typescript'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const source = await readFile(new URL('../src/i18n/locales/zh-CN.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { zhCN } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const messages = {}
function flatten(value, prefix = '') {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? prefix + '.' + key : key
    if (typeof item === 'string') { if (item) messages[path] = item }
    else flatten(item, path)
  }
}
flatten(zhCN)
const required_keys = ['common.confirm', 'common.cancel', 'interaction.permission', 'interaction.allow', 'interaction.deny']
for (const key of required_keys) if (!messages[key]) throw Error('Missing critical language key: ' + key)
const catalog = { schema_version: 1, revision: createHash('sha256').update(JSON.stringify(messages)).digest('hex'), required_keys, messages }
const target = new URL('../../daemon/data/languages/', import.meta.url)
await mkdir(target, { recursive: true })
await writeFile(new URL('catalog.json', target), JSON.stringify(catalog, null, 2) + '\n')
console.log('Language catalog: ' + Object.keys(messages).length + ' keys')
