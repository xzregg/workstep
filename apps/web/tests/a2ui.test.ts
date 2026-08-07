import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractA2uiMessages,
  hasA2uiBlocks,
  normalizeA2uiMessages,
  stripA2uiBlocks,
} from '../src/utils/a2ui.ts'

const createSurfaceLine = JSON.stringify({
  version: 'v0.9.1',
  type: 'createSurface',
  createSurface: {
    surfaceId: 'main',
    title: 'A2UI 演示',
    catalogId: '',
    components: [],
  },
})

test('extracts single-line JSONL messages from a complete fence', () => {
  const content = [
    '先说明',
    '',
    '```a2ui',
    createSurfaceLine,
    '{"version":"v0.9.1","type":"updateComponents","updateComponents":{"surfaceId":"main","components":[{"component":"Text","id":"t1","text":"## 说明"}]}}',
    '```',
    '',
    '结尾正文',
  ].join('\n')

  const messages = extractA2uiMessages(content)
  assert.equal(messages.length, 2)
  assert.ok('createSurface' in messages[0])
  assert.ok('updateComponents' in messages[1])
  if ('createSurface' in messages[0]) {
    assert.equal(messages[0].createSurface.surfaceId, 'main')
  }
  if ('updateComponents' in messages[1]) {
    assert.deepEqual(messages[1].updateComponents.components, [
      { component: 'Text', id: 't1', text: '## 说明' },
    ])
  }
})

test('accumulates pretty-printed multi-line JSON without losing messages', () => {
  const payload = {
    version: 'v0.9.1',
    type: 'updateComponents',
    updateComponents: {
      surfaceId: 'main',
      components: [
        { component: 'Text', id: 't1', text: '## 说明' },
        { component: 'Image', id: 'img1', url: '项目A/.workstep/uploads/abc-123.png' },
      ],
    },
  }
  const content = '```a2ui\n' + JSON.stringify(payload, null, 2) + '\n```'

  const messages = extractA2uiMessages(content)
  assert.equal(messages.length, 1)
  assert.ok('updateComponents' in messages[0])
  if ('updateComponents' in messages[0]) {
    assert.equal(messages[0].updateComponents.components.length, 2)
    assert.equal(
      (messages[0].updateComponents.components[1] as { url?: string }).url,
      '项目A/.workstep/uploads/abc-123.png',
    )
  }
})

test('skips stray non-JSON text inside a fence', () => {
  const content = [
    '```a2ui',
    '这是一段模型输出的杂散文字',
    createSurfaceLine,
    '```',
  ].join('\n')

  const messages = extractA2uiMessages(content)
  assert.equal(messages.length, 1)
})

test('ignores unclosed streaming fences', () => {
  const content = '```a2ui\n' + createSurfaceLine
  assert.equal(extractA2uiMessages(content).length, 0)
  assert.equal(hasA2uiBlocks(content), false)
  assert.equal(stripA2uiBlocks(content), content)
})

test('detects complete fences and leaves plain text alone', () => {
  assert.equal(hasA2uiBlocks('```a2ui\n{}\n```'), true)
  assert.equal(hasA2uiBlocks('```a2ui\n' + createSurfaceLine), false)
  assert.equal(hasA2uiBlocks('正文没有围栏'), false)
})

test('strips complete fences and keeps surrounding text', () => {
  const content = 'A\n```a2ui\n{}\n```\nB'
  assert.equal(stripA2uiBlocks(content), 'A\nB')

  const withBody = [
    '开头说明',
    '',
    '```a2ui',
    createSurfaceLine,
    '```',
    '',
    '结尾正文',
  ].join('\n')
  const stripped = stripA2uiBlocks(withBody)
  assert.ok(!stripped.includes('```a2ui'))
  assert.ok(stripped.includes('开头说明'))
  assert.ok(stripped.includes('结尾正文'))
})

test('normalizes project-relative upload paths for Image components', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Image', id: 'img1', url: '项目A/.workstep/uploads/abc-123.png' },
          { component: 'Text', id: 't1', text: '说明' },
          { component: 'Image', id: 'img2', url: 'https://example.com/pic.png' },
        ],
      },
    },
  ]

  const normalized = normalizeA2uiMessages(messages, '项目A')
  assert.ok('updateComponents' in normalized[0])
  if ('updateComponents' in normalized[0]) {
    const components = normalized[0].updateComponents.components as Array<
      { component: string; url?: string }
    >
    assert.equal(
      components[0].url,
      '/api/fs/serve/abc-123.png?project_id=%E9%A1%B9%E7%9B%AEA',
    )
    assert.equal(components[1].url, undefined)
    assert.equal(components[2].url, 'https://example.com/pic.png')
  }
})

test('leaves messages untouched when no project id is provided', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Image', id: 'img1', url: '项目A/.workstep/uploads/abc-123.png' },
        ],
      },
    },
  ]
  assert.equal(normalizeA2uiMessages(messages, undefined), messages)
})
