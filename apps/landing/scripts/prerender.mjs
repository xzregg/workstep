import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function prerenderDocument(html, markup) {
  if (!markup.includes('<main') || !markup.includes('<h1')) {
    throw new Error('预渲染缺少首页正文，停止生成空壳页面')
  }
  const script = html.match(/<script\s+type="module"(?:\s+crossorigin)?\s+src="([^"]+)"/)
  if (!script) throw new Error('构建产物缺少客户端入口脚本')
  const assetBase = script[1].slice(0, script[1].lastIndexOf('/') + 1)
  // Vite SSR uses root-relative asset URLs even for relative client builds.
  // Resolve them against the emitted client entry for file:// and subpaths.
  const content = markup.replace(/\b(src|poster|href)="\/assets\//g, (_, attribute) => `${attribute}="${assetBase}`)
  const root = '<div id="root"></div>'
  if (!html.includes(root)) throw new Error('构建产物缺少预渲染目标节点')
  return html.replace(root, () => `<div id="root">${content}</div>`)
}

async function main() {
  const cacheDir = path.join(appDir, 'node_modules', '.cache')
  await mkdir(cacheDir, { recursive: true })
  const rendererDir = await mkdtemp(path.join(cacheDir, 'landing-prerender-'))
  try {
    await build({
      root: appDir,
      base: '/',
      logLevel: 'error',
      build: {
        ssr: path.join(appDir, 'src', 'prerender.tsx'),
        outDir: rendererDir,
        copyPublicDir: false,
        rollupOptions: { output: { entryFileNames: 'renderer.mjs' } },
      },
    })
    const { renderHomepage } = await import(pathToFileURL(path.join(rendererDir, 'renderer.mjs')).href)
    const indexPath = path.join(appDir, 'dist', 'index.html')
    const html = await readFile(indexPath, 'utf8')
    await writeFile(indexPath, prerenderDocument(html, renderHomepage()))
    console.log('首页静态正文已生成，交互仍由浏览器应用接管')
  } finally {
    await rm(rendererDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
