import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('project folder button toggles its nested sidebar content independently of selection', () => {
  assert.match(source, /const \[expandedProjectId, setExpandedProjectId\] = useState<string \| null>/)
  assert.match(source, /setExpandedProjectId\(\(current\) => current === p\.id \? null : p\.id\)/)
  assert.match(source, /aria-expanded=\{expandedProjectId === p\.id\}/)
  assert.match(source, /expandedProjectId === p\.id && \(/)
  assert.doesNotMatch(source, /\{activeProject\?\.id === p\.id && \(/)
  assert.match(source, /if \(activeProject\?\.id\) setExpandedProjectId\(activeProject\.id\)/)
})
