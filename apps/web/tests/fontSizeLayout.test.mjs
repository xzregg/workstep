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

