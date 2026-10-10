import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import config from '../vite.config'

test('built lazy assets resolve inside the source workspace, including deep links', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'workstep-assets-'))
  try {
    await writeFile(join(root, 'index.html'), '<head></head><script type="module" src="/main.js"></script>')
    await writeFile(join(root, 'main.js'), 'window.loadDiagram = () => import("./diagram.js")')
    await writeFile(join(root, 'diagram.js'), 'import "./diagram.css"; export const diagram = true')
    await writeFile(join(root, 'diagram.css'), '.diagram { color: red }')
    const settings = await (config as Function)({ command: 'build', mode: 'production' })
    const result = await build({ ...settings, configFile: false, root, logLevel: 'silent',
      build: { ...settings.build, write: false, minify: false } })
    const output = (Array.isArray(result) ? result[0] : result).output
    const entry = output.find(item => item.type === 'chunk' && item.isEntry)!
    assert.equal(entry.type, 'chunk')
    if (entry.type !== 'chunk') return
    const html = output.find(item => item.fileName === 'index.html')!
    assert.equal(html.type, 'asset')
    if (html.type !== 'asset') return
    assert.match(String(html.source), /src="\/assets\//)
    // Execute Vite's generated helper using the actual source module URL.
    const { Window } = await import('happy-dom')
    for (const page of ['https://gateway.test/workspace/one/tasks', 'https://gateway.test/workspace/two/chat', 'https://device.test/share/token']) {
      const window = new Window({ url: page })
      const moduleUrl = new URL(entry.fileName, page.includes('/workspace/') ? page.replace(/(tasks|chat)$/, '') : 'https://device.test/').href
      const source = entry.code.replaceAll('import.meta.url', JSON.stringify(moduleUrl)).replaceAll('import.meta.resolve', 'undefined')
      new Function('window', 'document', 'MutationObserver', source)(window, window.document, window.MutationObserver)
      // CSS preloads wait for load, so the dynamic import does not run here.
      void (window as any).loadDiagram()
      const link = window.document.querySelector('link[rel="stylesheet"]')!
      assert.ok(link)
      assert.equal(new URL(link.href).pathname.replace(/[^/]+$/, ''), new URL(moduleUrl).pathname.replace(/[^/]+$/, ''))
      await window.happyDOM.close()
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
