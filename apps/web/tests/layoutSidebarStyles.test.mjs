import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const layout = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/components/Layout.css', import.meta.url), 'utf8').catch(() => '')

test('sidebar fixed styles have named owners and project row states use attributes', () => {
  assert.match(layout, /className="layout-sidebar"/)
  assert.match(layout, /className="layout-project-row ws-row"/)
  assert.match(layout, /data-active=\{activeProject\?\.id === p\.id\}/)
  assert.match(css, /\.layout-project-row\s*\{/)
  assert.match(css, /\.layout-project-row\[data-active="true"\]/)
  assert.doesNotMatch(layout, /const (sidebarStyle|sectionLabel|nestedSectionLabel|projectItemStyle|addButtonStyle)/)
})
