import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const utilitySource = await readFile(new URL('../src/utils/markdownImages.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(utilitySource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { removeMarkdownImage, resolveMarkdownImageSrc, splitMarkdownImages } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)
const chatInputSource = await readFile(new URL('../src/components/ChatInput.tsx', import.meta.url), 'utf8')

test('splits Markdown images into ordered visual-editor segments without changing the source', () => {
  const value = '先看这里\n\n![界面](demo/.workstep/uploads/shot.png)\n\n再看下面'
  const segments = splitMarkdownImages(value)

  assert.deepEqual(segments.map((segment) => segment.type), ['text', 'image', 'text'])
  assert.equal(segments[1].alt, '界面')
  assert.equal(segments[1].url, 'demo/.workstep/uploads/shot.png')
  assert.equal(segments.map((segment) => segment.markdown).join(''), value)
})

test('removing an image deletes its Markdown token and only the adjacent separator', () => {
  const value = '上面的文字\n\n![图片](demo/.workstep/uploads/shot.png)\n\n下面的文字'
  const image = splitMarkdownImages(value).find((segment) => segment.type === 'image')

  assert.ok(image)
  assert.equal(removeMarkdownImage(value, image), '上面的文字\n\n下面的文字')
})

test('resolves project and global upload paths through the upload serving endpoint', () => {
  assert.equal(
    resolveMarkdownImageSrc('.workstep/uploads/界面.png', 'project-id'),
    '/api/fs/serve/%E7%95%8C%E9%9D%A2.png?project_id=project-id',
  )
  assert.equal(
    resolveMarkdownImageSrc('demo/.workstep/uploads/界面.png', 'project-id'),
    '/api/fs/serve/%E7%95%8C%E9%9D%A2.png?project_id=project-id',
  )
  assert.equal(
    resolveMarkdownImageSrc('data/uploads/shared.png'),
    '/api/fs/serve/shared.png',
  )
})

test('chat input renders image blocks in source order and exposes preview and removal actions', () => {
  assert.match(chatInputSource, /splitMarkdownImages\(value\)/)
  assert.match(chatInputSource, /className="chat-input-image"/)
  assert.match(chatInputSource, /className="chat-input-image-remove"/)
  assert.match(chatInputSource, /removeMarkdownImage\(value, segment\)/)
})
