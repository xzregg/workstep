import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGitPatch } from '../src/components/git/gitDiff'

test('diff aligns removed and added lines while retaining source line numbers and function headers', () => {
  const hunks = parseGitPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4,3 +4,4 @@ function pay()\n context\n-old\n+new\n+extra\n tail\n')
  assert.equal(hunks[0].label, 'function pay()')
  assert.deepEqual(hunks[0].rows.map(r => [r.before?.number, r.after?.number]), [[4,4], [5,5], [undefined,6], [6,7]])
  assert.equal(hunks[0].rows[1].before?.text, 'old')
  assert.equal(hunks[0].rows[1].after?.text, 'new')
})
