import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/components/git/git.css', import.meta.url), 'utf8')
const workspace = await readFile(new URL('../src/pages/GitWorkspace.tsx', import.meta.url), 'utf8')
const changes = await readFile(new URL('../src/components/git/GitChanges.tsx', import.meta.url), 'utf8')

test('mobile Git workspace keeps its fixed chrome compact so the file list can grow', () => {
  assert.match(css, /@media \(max-width:1023px\)[\s\S]*?\.git-page-header\s*\{[^}]*min-height:\s*calc\(var\(--mobile-control-regular\) \+ 8px\)[^}]*flex-wrap:\s*nowrap/)
  assert.match(css, /@media \(max-width:1023px\)[\s\S]*?\.git-page-header \.git-back-button\s*\{[^}]*width:\s*var\(--mobile-control-regular\)/)
  assert.match(css, /@media \(max-width:1023px\)[\s\S]*?\.git-context p\s*\{[^}]*display:\s*none/)
  assert.match(css, /@media \(max-width:1023px\)[\s\S]*?\.git-commit-hint\s*\{[^}]*display:\s*none/)
  assert.match(css, /@media \(max-width:1023px\)[\s\S]*?\.git-commit-form textarea\s*\{[^}]*min-height:\s*44px/)
  assert.doesNotMatch(css, /@media \(max-width:1023px\)[\s\S]*?\.git-(?:page-header|context|file-toolbar|message-header)[^{]*\{[^}]*min-height:\s*44px/)
})

test('compact mobile-only controls retain accessible names', () => {
  assert.match(workspace, /className="git-back-button"[\s\S]*?aria-label=\{t\('git\.back'\)\}/)
  assert.match(workspace, /className="git-settings-toggle"[\s\S]*?aria-label=\{t\('git\.settings'\)\}/)
  assert.match(changes, /className="git-commit-hint"/)
})
