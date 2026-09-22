import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(appDir, 'dist')

function requiredMatch(html, pattern, label) {
  const match = html.match(pattern)
  if (!match) throw new Error(`无法在构建产物中找到${label}`)
  return match
}

function assetPath(reference) {
  return path.join(distDir, 'assets', path.basename(reference))
}

export function inlineDocument({ html, javascript, stylesheet, favicon, brandMark }) {
  const brandMarkData = `data:image/svg+xml;base64,${Buffer.from(brandMark).toString('base64')}`
  const faviconData = `data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}`
  const safeStylesheet = stylesheet
    .replace(/url\((['"]?)[^)]*brand-mark\.svg\1\)/g, `url("${brandMarkData}")`)
    .replace(/<\/style/gi, '<\\/style')
  const safeJavascript = javascript.replace(/<\/script/gi, '<\\/script')

  const output = html
    .replace(
      /<link\s+rel="icon"[^>]*>/,
      () => `<link rel="icon" type="image/svg+xml" href="${faviconData}">`,
    )
    .replace(
      /<script\s+type="module"(?:\s+crossorigin)?\s+src="[^"]+"><\/script>/,
      '',
    )
    .replace(
      /<link\s+rel="stylesheet"(?:\s+crossorigin)?\s+href="[^"]+">/,
      () => `<style>${safeStylesheet}</style>`,
    )
    .replace('</body>', () => `<script>${safeJavascript}</script>\n  </body>`)

  const externalBuildResources = [
    ['入口脚本', /<script\s+type="module"(?:\s+crossorigin)?\s+src="[^"]+"><\/script>/i],
    ['样式表', /<link\s+rel="stylesheet"(?:\s+crossorigin)?\s+href="[^"]+">/i],
    ['favicon', /<link\b[^>]*\brel="icon"[^>]*\bhref=(?!"data:)/i],
    ['品牌图标', /url\((['"]?)[^)]*brand-mark\.svg\1\)/i],
  ]
  const remaining = externalBuildResources
    .filter(([, pattern]) => pattern.test(output))
    .map(([label]) => label)
  if (remaining.length > 0) {
    throw new Error(`构建产物仍包含无法通过 file:// 加载的外部资源：${remaining.join('、')}`)
  }
  if (output.lastIndexOf('<script>') < output.indexOf('<div id="root"></div>')) {
    throw new Error('应用脚本必须在 React 根节点之后执行')
  }

  return output
}

async function main() {
  const indexPath = path.join(distDir, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  const scriptReference = requiredMatch(
    html,
    /<script\s+type="module"(?:\s+crossorigin)?\s+src="([^"]+)"><\/script>/,
    '入口脚本',
  )[1]
  const stylesheetReference = requiredMatch(
    html,
    /<link\s+rel="stylesheet"(?:\s+crossorigin)?\s+href="([^"]+)">/,
    '样式表',
  )[1]

  const [javascript, stylesheet, favicon, brandMark] = await Promise.all([
    readFile(assetPath(scriptReference), 'utf8'),
    readFile(assetPath(stylesheetReference), 'utf8'),
    readFile(path.join(appDir, 'public', 'favicon.svg'), 'utf8'),
    readFile(path.join(appDir, 'public', 'brand-mark.svg'), 'utf8'),
  ])

  const output = inlineDocument({ html, javascript, stylesheet, favicon, brandMark })
  await writeFile(indexPath, output)
  console.log(`单文件页面已生成：dist/index.html (${Math.ceil(Buffer.byteLength(output) / 1024)} KiB)`)
}

await main()
