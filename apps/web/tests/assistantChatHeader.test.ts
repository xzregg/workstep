import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const workspaceStyles = await readFile(new URL('../src/pages/ChatWorkspace.css', import.meta.url), 'utf8')

test('wide chat panes reserve inline action space instead of floating the toolbar', () => {
  assert.match(workspaceStyles, /container: chat-pane \/ inline-size/)
  assert.match(workspaceStyles, /@container chat-pane \(min-width: 900px\)\s*\{\s*\.chat-workspace-pane \.chat-header-hover-actions\s*\{[^}]*position: static;[^}]*flex-wrap: nowrap;[^}]*padding: 0;[^}]*border: 0;/)
})

test('desktop secondary actions float without moving Git and settings, and ignore persistent-action hover', () => {
  assert.match(workspaceStyles, /@media \(min-width: 1024px\) and \(hover: hover\) and \(pointer: fine\)/)
  assert.match(workspaceStyles, /\.chat-header-hover-actions\s*\{[^}]*position: absolute;[^}]*top: 100%;[^}]*opacity: 0;[^}]*pointer-events: none;/)
  assert.match(workspaceStyles, /\.assistant-chat-header:hover:not\(:has\(\.chat-header-persistent-actions:hover\)\) \.chat-header-hover-actions/)
  assert.match(workspaceStyles, /\.chat-header-hover-actions:focus-within/)
  assert.match(workspaceStyles, /\.chat-header-hover-actions:has\(\[aria-expanded="true"\]\)/)
})

test('assistant chat header title stays on one line within 30% of the header', () => {
  assert.match(assistantPanelSource, /className="assistant-chat-header-title"/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?max-width:\s*30%/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?white-space:\s*nowrap/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?overflow:\s*hidden/)
  assert.match(styles, /\.assistant-chat-header-title\s*\{[\s\S]*?text-overflow:\s*ellipsis/)
})
