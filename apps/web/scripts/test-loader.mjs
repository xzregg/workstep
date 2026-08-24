import { access, readFile } from 'node:fs/promises'
import { dirname, extname, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const extensions = new Set(['.ts', '.tsx'])

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (
      !['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(error?.code) ||
      !(specifier.startsWith('.') || specifier.startsWith('/'))
    ) throw error
    const base = specifier.startsWith('/')
      ? specifier
      : resolvePath(dirname(new URL(context.parentURL).pathname), specifier)
    for (const candidate of [
      ...['.ts', '.tsx', '.js'].map((extension) => `${base}${extension}`),
      ...['.ts', '.tsx', '.js'].map((extension) => `${base}/index${extension}`),
    ]) {
      try {
        await access(candidate)
        return { url: pathToFileURL(candidate).href, shortCircuit: true }
      } catch {}
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  const pathname = new URL(url).pathname
  const extension = pathname.slice(pathname.lastIndexOf('.'))
  if (!extensions.has(extension)) return nextLoad(url, context)

  const source = await readFile(new URL(url), 'utf8')
  const transformed = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: false,
    },
    fileName: pathname,
  })
  return {
    format: 'module',
    source: transformed.outputText,
    shortCircuit: true,
  }
}
