import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGitPatch, changedBlocks, expandHunks, restoreDiffBlock } from '../src/components/git/gitDiff'

test('diff aligns removed and added lines while retaining source line numbers and function headers', () => {
  const hunks = parseGitPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4,3 +4,4 @@ function pay()\n context\n-old\n+new\n+extra\n tail\n')
  assert.equal(hunks[0].label, 'function pay()')
  assert.deepEqual(hunks[0].rows.map(r => [r.before?.number, r.after?.number]), [[4,4], [5,5], [undefined,6], [6,7]])
  assert.equal(hunks[0].rows[1].before?.text, 'old')
  assert.equal(hunks[0].rows[1].after?.text, 'new')
})

test('full file view includes unchanged lines before, between, and after diff hunks', () => {
  const before = 'first\nold one\nmiddle one\nmiddle two\nold two\nlast\n'
  const after = 'first\nnew one\nmiddle one\nmiddle two\nnew two\nlast\n'
  const hunks = parseGitPatch('@@ -2 +2 @@\n-old one\n+new one\n@@ -5 +5 @@\n-old two\n+new two\n')
  const full = expandHunks(before, after, hunks)
  assert.deepEqual(full.rows.map(row => [row.before?.text, row.after?.text]), [
    ['first', 'first'], ['old one', 'new one'], ['middle one', 'middle one'],
    ['middle two', 'middle two'], ['old two', 'new two'], ['last', 'last'],
  ])
  assert.deepEqual(changedBlocks(full), [{ start: 1, end: 2 }, { start: 4, end: 5 }])
  assert.deepEqual(expandHunks('same\n', 'same\n', []).rows.map(row => row.after?.text), ['same'])
})

test('restore a changed block from the committed side without changing adjacent lines', () => {
  const cases = [
    { patch: '@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+extra\n tail\n', after: 'keep\nnew\nextra\ntail\n', expected: 'keep\nold\ntail\n' },
    { patch: '@@ -1,3 +1,2 @@\n keep\n-lost\n tail\n', after: 'keep\ntail\n', expected: 'keep\nlost\ntail\n' },
    { patch: '@@ -1,2 +1,3 @@\n keep\n+extra\n tail\n', after: 'keep\nextra\ntail\n', expected: 'keep\ntail\n' },
    { patch: '@@ -1,2 +1,1 @@\n-lost\n keep\n', after: 'keep\n', expected: 'lost\nkeep\n' },
  ]
  for (const { patch, after, expected } of cases) {
    const hunk = parseGitPatch(patch)[0]
    const [block] = changedBlocks(hunk)
    assert.equal(restoreDiffBlock(after, hunk, block), expected)
    assert.equal(restoreDiffBlock('changed since review\n', hunk, block), null)
  }
})

test('restore a deletion at the beginning and the entire committed file', () => {
  const deleted = parseGitPatch('@@ -1 +0,0 @@\n-old\n')[0]
  assert.equal(restoreDiffBlock('', deleted, changedBlocks(deleted)[0], 'old\n'), 'old\n')
  const inserted = parseGitPatch('@@ -0,0 +1 @@\n+new\n')[0]
  assert.equal(restoreDiffBlock('new\n', inserted, changedBlocks(inserted)[0], ''), '')
})
