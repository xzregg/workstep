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


test('settings typography uses the shared font scale and navigation can grow with text', async () => {
  for (const path of ['pages/DecisionModelSettings.css', 'components/SettingsNavigation.css', 'components/EngineSettingsPanel.css', 'components/SandboxSettings.css', 'components/BotDirectorySettings.css', 'components/ProblemFeedbackSettings.css', 'pages/GatewayPlatformSettings.css', 'pages/GitScanSettings.css']) {
    const source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
    for (const declaration of source.matchAll(/font-size:\s*([^;}]+)/g)) {
      assert.match(declaration[1], /var\(--(?:font-scale|text-[^)]+)\)|inherit/, `${path}: ${declaration[0]}`)
    }
  }
  const navigation = await readFile(new URL('../src/components/SettingsNavigation.css', import.meta.url), 'utf8')
  assert.match(navigation, /height:\s*auto/)
  assert.doesNotMatch(navigation, /(?<!min-)height:\s*(?:28|30)px/)
})
