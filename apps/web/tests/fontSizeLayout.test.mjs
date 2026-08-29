import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

function rule(selector) {
  return css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

test('font size preferences never resize the application viewport', () => {
  const rootRule = rule('#root')

  assert.match(rootRule, /width:\s*100%/)
  assert.match(rootRule, /height:\s*100vh/)
  assert.doesNotMatch(rootRule, /zoom:/)
  assert.doesNotMatch(css, /--ui-viewport-(?:width|height)/)
})

test('font size preferences change only the shared font scale', () => {
  for (const preference of ['small', 'large', 'extraLarge']) {
    const preferenceRule = rule(`:root[data-font-size="${preference}"]`)
    assert.match(preferenceRule, /--font-scale:\s*[\d.]+/)
    assert.doesNotMatch(preferenceRule, /(?:width|height|zoom):/)
  }
})

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
    return entry.isDirectory() ? sourceFiles(url) : [url]
  }))
  return files.flat()
}

test('fixed interface font sizes opt into the shared font scale', async () => {
  const src = new URL('../src/', import.meta.url)
  const files = (await sourceFiles(src)).filter((url) => /\.(?:css|ts|tsx)$/.test(url.pathname))

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assert.doesNotMatch(source, /fontSize:\s*\d+(?:\.\d+)?\b/, `${file.pathname} has an unscaled inline font size`)
    assert.doesNotMatch(source, /font-size:\s*\d+(?:\.\d+)?px\b/, `${file.pathname} has an unscaled CSS font size`)
    assert.doesNotMatch(source, /font:\s*(?![^;\n]*var\(--font-scale\))[^;\n]*\b\d+(?:\.\d+)?px\b/, `${file.pathname} has an unscaled CSS font shorthand`)
  }
})
