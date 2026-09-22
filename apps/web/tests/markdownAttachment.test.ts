import assert from 'node:assert/strict'
import test from 'node:test'

import { formatMarkdownAttachment } from '../src/utils/markdownAttachment.ts'

test('formats uploaded images and ordinary files as Markdown links', () => {
  assert.equal(
    formatMarkdownAttachment(
      { name: 'screen.png', type: 'image/png' },
      'demo/.workstep/uploads/a.png',
    ),
    '![screen.png](demo/.workstep/uploads/a.png)',
  )
  assert.equal(
    formatMarkdownAttachment(
      { name: 'requirements.pdf', type: 'application/pdf' },
      'demo/.workstep/uploads/b.pdf',
    ),
    '[requirements.pdf](demo/.workstep/uploads/b.pdf)',
  )
})

test('escapes brackets in attachment labels', () => {
  assert.equal(
    formatMarkdownAttachment(
      { name: 'screen[final].png', type: 'image/png' },
      'demo/.workstep/uploads/a.png',
    ),
    String.raw`![screen\[final\].png](demo/.workstep/uploads/a.png)`,
  )
})
