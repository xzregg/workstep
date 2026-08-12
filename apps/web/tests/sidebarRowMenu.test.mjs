import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('project and workflow rows reveal a "..." more button only on hover', () => {
  assert.match(css, /\.ws-row \.ws-more-btn/)
  assert.match(css, /\.ws-row:hover \.ws-more-btn/)
  const rows = source.match(/className="ws-row"/g) ?? []
  const moreButtons = source.match(/className="ws-more-btn"/g) ?? []
  assert.ok(rows.length >= 2, 'project row and workflow row should both carry the ws-row hover class')
  assert.ok(moreButtons.length >= 2, 'project row and workflow row should both render a ws-more-btn button')
})

test('clicking the more button opens an edit/delete menu for projects and workflows', () => {
  assert.match(source, /openMoreMenu\(e, 'project', p\.path\)/)
  assert.match(source, /openMoreMenu\(e, 'workflow', wf\.id\)/)
  assert.match(source, /setRenameId\(menuTarget\.path\)/)
  assert.match(source, /setDeleteProjectTarget\(menuTarget\)/)
  assert.match(source, /setRenameWfId\(menuTarget\.workflow\.id\)/)
  assert.match(source, /setDeleteWf\(\{/)
})
