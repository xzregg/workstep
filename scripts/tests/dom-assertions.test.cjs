const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const { createRequire } = require('node:module')
const ts = createRequire(path.resolve(__dirname, '../../apps/web/package.json'))('typescript')
const { findDomAssertionRisks } = require('../check-dom-assertions.cjs')

test('DOM assertion guard catches nodes, aliases, collections and arrays while accepting primitive projections', () => {
  const file = path.resolve(__dirname, '../../apps/web/tests/dom-assertion-fixture.ts')
  const code = `import assert, { strictEqual as same } from 'node:assert/strict'
const node = document.querySelector('button')
const query = () => node
assert.equal(node, null)
assert.notEqual(document.activeElement, node)
same(query(), null)
assert.deepEqual(document.querySelectorAll('button'), [])
assert.deepEqual([node], [document.body])
assert.equal(window, null)
assert.equal(document, null)
assert.equal(document.children, null)
assert.strict.equal(node, null)
assert.ok(node === null)
assert.equal(node?.textContent, '')
assert.equal(node?.getAttribute('title'), '')
assert.equal(document.querySelectorAll('button').length, 0)
assert.deepEqual([node?.textContent], [''])
assert.equal(Boolean(node), false)
type Recursive = string | Recursive[]
declare const recursive: Recursive
assert.deepEqual(recursive, [])
assert.deepEqual(new Set([node]), new Set())
assert.deepEqual(new Map([['node', node]]), new Map())
`
  const options = { strictNullChecks: true, target: ts.ScriptTarget.ESNext }
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, ...args) => name === file
    ? ts.createSourceFile(file, code, options.target, true)
    : originalGetSourceFile(name, ...args)
  const program = ts.createProgram([file], options, host)
  assert.deepEqual(findDomAssertionRisks(ts, program, [file]).map(risk => risk.line), [4, 5, 6, 7, 8, 9, 10, 11, 12, 22, 23])
})
