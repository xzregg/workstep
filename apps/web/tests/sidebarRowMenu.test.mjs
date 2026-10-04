import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
const menuCss = await readFile(new URL('../src/components/SidebarActionMenu.css', import.meta.url), 'utf8')

test('project and workflow rows reveal a "..." more button only on hover', () => {
  assert.match(css, /\.ws-row \.ws-more-btn/)
  assert.match(css, /\.ws-row:hover \.ws-more-btn/)
  const rows = source.match(/className="[^"]*\bws-row\b[^"]*"/g) ?? []
  const moreButtons = source.match(/className="ws-more-btn"/g) ?? []
  assert.ok(rows.length >= 2, 'project row and workflow row should both carry the ws-row hover class')
  assert.ok(moreButtons.length >= 2, 'project row and workflow row should both render a ws-more-btn button')
})

test('compact layouts keep row actions hover-driven when a mouse is available', () => {
  assert.doesNotMatch(
    mobileCss,
    /\.chat-message-row \.chat-message-action, \.chat-message-row \.footer-usage-summary, \.ws-row \.ws-more-btn/,
  )
  assert.match(mobileCss, /@media \(hover: none\), \(pointer: coarse\)/)
})

test('clicking the more button opens an edit/delete menu for projects and workflows', () => {
  assert.match(source, /openMoreMenu\(e, 'project', p\.id\)/)
  assert.match(source, /openMoreMenu\(e, 'workflow', wf\.id\)/)
  assert.match(source, /setRenameId\(menuTarget\.path\)/)
  assert.match(source, /setDeleteProjectTarget\(menuTarget\)/)
  assert.match(source, /setRenameWfId\(menuTarget\.workflow\.id\)/)
  assert.match(source, /setDeleteWf\(\{/)
})

test('touch long press opens the existing project and session more menus', () => {
  assert.match(source, /const startSidebarLongPress =/)
  assert.match(source, /pointerType !== 'touch'/)
  assert.match(source, /SIDEBAR_LONG_PRESS_MS/)
  assert.match(source, /startSidebarLongPress\(e, \(x, y\) => openMoreMenuAt\('project', p\.id, x, y\)\)/)
  assert.match(source, /startSidebarLongPress\(e, \(x, y\) => openSessionMenuAt\(p\.id, session\.id, session\.title, x, y\)\)/)
  assert.match(source, /onPointerMove=\{moveSidebarLongPress\}/)
  assert.match(source, /consumeSidebarLongPressClick\(\)/)
})

test('sidebar row menus render above the mobile navigation drawer', () => {
  assert.match(mobileCss, /\.responsive-navigation\s*\{[^}]*z-index:\s*1201/s)
  const menus = source.match(/<SidebarActionMenu /g) ?? []
  assert.equal(menus.length, 2, 'project/workflow and session menus should use the shared layer')
  assert.match(menuCss, /\.sidebar-action-menu\s*\{[^}]*z-index:\s*1302/s)
})
