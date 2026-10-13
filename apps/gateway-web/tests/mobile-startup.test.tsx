import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('portal loads its complete stylesheet cascade before application scripts', () => {
 const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
 const head = html.slice(0, html.indexOf('</head>'))
 const styles = ['gateway', 'AdminTabs', 'DirectWorkstepWorkspace', 'NotificationCenter', 'AdminPermissionsPage', 'projectInvitations', 'AdminCompact']
 let previous = head.indexOf('name="viewport"')
 for (const name of styles) {
  const position = head.indexOf(`href="/src/${name}.css"`)
  assert.ok(position > previous, `${name} must load in cascade order in the head`)
  previous = position
 }
 const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
 assert.doesNotMatch(main, /import ['"].*\.css['"]/, 'entry styles must not depend on JavaScript execution')
})
