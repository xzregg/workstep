import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/manual')
const chapters = []
for (const [file, exported] of [['onboarding.ts', 'onboardingChapters'], ['features.ts', 'featureChapters']]) {
  const source = await readFile(path.join(root, file), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } })
  const module = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
  chapters.push(...module[exported])
}
const gaps = []
let count = 0
for (const chapter of chapters) {
  for (const section of chapter.sections) {
    if (!section.screenshot) continue
    count++
    try { await access(path.join(root, 'screenshots', `${section.screenshot.id}.jpg`)) }
    catch { gaps.push(`${chapter.title} / ${section.title}: ${section.screenshot.id}.jpg`) }
  }
}
console.log(`操作手册：${chapters.length} 章，截图 ${count - gaps.length}/${count}`)
if (gaps.length) {
  console.error('待补真实截图：\n' + gaps.map(gap => `- ${gap}`).join('\n'))
  process.exitCode = 1
}
