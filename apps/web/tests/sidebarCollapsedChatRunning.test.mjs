import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const activityHook = await readFile(new URL('../src/hooks/useSidebarActivity.ts', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

test('collapsed project row derives its spinner from per-project running chat sessions', () => {
  // Session → project ownership is accumulated from loaded session lists.
  assert.match(activityHook, /const \[sessionProjectMap, setSessionProjectMap\] = useState<Record<string, string>>\(\{\}\)/)
  assert.match(activityHook, /for \(const item of sessions\)/)
  // The collapsed-row condition consults the owning project, not just the
  // active project, and includes the backend aggregate flag.
  assert.match(source, /\|\| p\.has_running_tasks/)
  assert.match(source, /const sessionRunning = projectHasRunningSession\(p\.id\)/)
  // Running sessions are filtered by project ownership (no global fallback
  // that would light up every project).
  assert.match(activityHook, /sessionProjectMap\[sessionId\] === projectId/)
  assert.doesNotMatch(activityHook, /Object\.values\(runningChatSessions\)\.some\(Boolean\)/)
})

test('project list refreshes when chat turns start or finish', () => {
  assert.match(activityHook, /const runningSessionKey = Object\.entries\(runningChatSessions\)/)
  assert.match(activityHook, /if \(!previous && !runningSessionKey\) return/)
  assert.match(activityHook, /setTimeout\(\(\) => \{ void fetchProjects\(\) \}, 300\)/)
})

test('project type declares the backend running aggregate', () => {
  assert.match(client, /has_running_tasks\?: boolean/)
})

test('session rows restore their spinner from the API after refresh', () => {
  assert.match(client, /running\?: boolean/)
  assert.match(source, /const sessionRunning = Boolean\(runningChatSessions\[session\.id\]\)/)
})
