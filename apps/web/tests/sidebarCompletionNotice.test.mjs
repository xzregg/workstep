import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const layout = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const activityHook = await readFile(new URL('../src/hooks/useSidebarActivity.ts', import.meta.url), 'utf8')
const indicator = await readFile(new URL('../src/components/SidebarStatusIndicator.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('sidebar activity changes from running spinner to an unread completion dot', () => {
  assert.match(activityHook, /markWorkflowCompleted/)
  assert.match(activityHook, /markSessionCompleted/)
  assert.match(layout, /SidebarStatusIndicator/)
  assert.match(indicator, /sidebar-completion-dot/)
  assert.match(layout, /markProjectRead\(p\.id\)/)
  assert.match(layout, /markSessionRead\(session\.id\)/)
})

test('completion dot has a reduced-motion-safe arrival', () => {
  assert.match(css, /\.sidebar-completion-dot/)
  assert.match(css, /\.sidebar-failure-dot/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})
