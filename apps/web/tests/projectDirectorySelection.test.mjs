import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const directoryBrowserSource = await readFile(
  new URL('../src/components/DirectoryBrowser.tsx', import.meta.url),
  'utf8',
)
const projectConnectionDialogSource = await readFile(
  new URL('../src/components/ProjectConnectionDialog.tsx', import.meta.url),
  'utf8',
)

test('project creation selects a folder from the tree before confirmation', () => {
  assert.match(directoryBrowserSource, /aria-selected=\{entry\.type === 'directory' \? selectedPath === entry\.path : undefined\}/)
  assert.match(directoryBrowserSource, /onClick=\{entry\.type === 'directory' \? \(\) => onSelect\(entry\.path\) : undefined\}/)
  assert.match(directoryBrowserSource, /background: selectedPath === entry\.path \? 'var\(--accent\)' : 'transparent'/)
  assert.match(directoryBrowserSource, /color: selectedPath === entry\.path \? 'var\(--accent-fg\)'/)
  assert.doesNotMatch(directoryBrowserSource, /browser\.selectDir/)

  assert.match(projectConnectionDialogSource, /<DirectoryBrowser onSelect=\{setPath\} selectedPath=\{path\}(?:\s+[^>]+)? \/>/)
  assert.doesNotMatch(projectConnectionDialogSource, /id="init-path"/)
})
