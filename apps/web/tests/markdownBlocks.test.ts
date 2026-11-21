import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMarkdownBlocks } from '../src/utils/markdownBlocks'

test('stable paragraphs split without changing source offsets or losing separators', () => {
  const content = '# 标题\n\n正文 **强调**\n\n后续'
  const blocks = splitMarkdownBlocks(content)
  assert.deepEqual(blocks.map(block => block.content), ['# 标题\n\n', '正文 **强调**\n\n', '后续'])
  assert.equal(blocks.map(block => block.content).join(''), content)
  for (const block of blocks) assert.equal(content.slice(block.offset, block.offset + block.content.length), block.content)
})

test('fences keep blank lines and unfinished code inside one block', () => {
  const content = '正文\n\n```ts\na\n\nb\n```\n\n末尾'
  assert.deepEqual(splitMarkdownBlocks(content).map(block => block.content), ['正文\n\n', '```ts\na\n\nb\n```\n\n', '末尾'])
  assert.deepEqual(splitMarkdownBlocks('正文\n\n```ts\na\n\nb').map(block => block.content), ['正文\n\n', '```ts\na\n\nb'])
})

for (const content of ['- 外层\n\n  继续\n\n- 第二项', '> 引用\n\n> 继续', '[链接][ref]\n\n[ref]: https://example.com', '<div>\n\n正文\n\n</div>', '    indented\n\n    code', '`inline\n\ncode`']) {
  test(`cross-block constructs retain document context: ${content.slice(0, 15)}`, () => {
    assert.deepEqual(splitMarkdownBlocks(content), [{ offset: 0, content }])
  })
}

test('a closed simple list does not force later stable paragraphs to reparse', () => {
  const content = '开头\n\n- 第一项\n- 第二项\n\n正文\n\n追加'
  assert.deepEqual(splitMarkdownBlocks(content).map(block => block.content), [
    '开头\n\n', '- 第一项\n- 第二项\n\n', '正文\n\n', '追加',
  ])
})

test('loose list items retain one shared parsing context', () => {
  const content = '- 第一项\n\n- 第二项\n\n后续正文'
  assert.deepEqual(splitMarkdownBlocks(content).map(block => block.content), [
    '- 第一项\n\n- 第二项\n\n', '后续正文',
  ])
})

test('an indented fence inside a list retains its list context', () => {
  const content = '- 项目\n\n  ```ts\n  value\n  ```\n\n后续'
  assert.deepEqual(splitMarkdownBlocks(content), [{ offset: 0, content }])
})


test('simple list splits preserve the full Markdown rendering for every streaming prefix', () => {
  const samples = [
    '开头\n\n- 第一项 **重点**\n- 第二项\n\n正文\n\n末尾',
    '- 第一项\n\n- 第二项\n\n后续正文',
    '开头\n\n1. 第一项\n2. 第二项\n\n正文',
    '- 第一项\n继续第一项\n\n正文',
    '- 第一项\n\n  嵌套正文\n\n- 第二项',
    '- 第一项\n\n---\n\n正文',
    '- 第一项\n\n```ts\nvalue\n```\n\n正文',
    '- [ref]\n\n正文\n\n[ref]: https://example.com',
  ]
  const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text))
  const normalize = (html: string) => html.replace(/>\n+</g, '><')
  for (const sample of samples) for (let end = 1; end <= sample.length; end++) {
    const content = sample.slice(0, end)
    assert.equal(normalize(splitMarkdownBlocks(content).map(block => render(block.content)).join('')), normalize(render(content)), content)
  }
})
