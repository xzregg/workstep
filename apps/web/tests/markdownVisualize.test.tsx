import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { convertVisualizeMarkers } from '../src/utils/markdownVisualize.ts'

const VISUALIZE_PATH = (
  '/Users/xzr/Desktop/workstep/.workstep/visualizations/'
  + 'stage-progress-card-prototypes.html'
)

function render(content: string) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MarkdownMessage content={content} projectId="project-1" />
    </I18nProvider>,
  )
}

test('converts Codex visualize markers to Markdown file links', () => {
  const marker = `\ue200visualize\uE202{"path":"${VISUALIZE_PATH}","mode":"wide"}\ue201`
  const converted = convertVisualizeMarkers(`原型已生成。\n\n${marker}`)

  assert.equal(
    converted,
    '原型已生成。\n\n'
    + '[stage-progress-card-prototypes.html]'
    + `(file://${VISUALIZE_PATH})`,
  )
})

test('converts a trailing bare visualize marker', () => {
  const marker = `visualize{"path":"${VISUALIZE_PATH}","mode":"wide"}`

  assert.equal(
    convertVisualizeMarkers(`原型已生成。\n\n${marker}`),
    '原型已生成。\n\n'
    + '[stage-progress-card-prototypes.html]'
    + `(file://${VISUALIZE_PATH})`,
  )
})

test('keeps quoted, fenced and inline visualize examples untouched', () => {
  const bare = `visualize{"path":"${VISUALIZE_PATH}","mode":"wide"}`
  const quoted = `怎么会渲染成 "${bare}"？`
  const fenced = `它的实际形态是：\n\`\`\`text\n${bare}\n\`\`\``
  const inline = `我们讨论 ${bare} 这个标记。`

  assert.equal(convertVisualizeMarkers(quoted), quoted)
  assert.equal(convertVisualizeMarkers(fenced), fenced)
  assert.equal(convertVisualizeMarkers(inline), inline)
})

test('message component renders converted visualize markers as clickable file links', () => {
  const marker = `\ue200visualize\uE202{"path":"${VISUALIZE_PATH}","mode":"wide"}\ue201`
  const html = render(`原型已生成。\n\n${marker}`)

  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, /data-file-preview="true"/)
  assert.match(
    html,
    /href="file:\/\/\/Users\/xzr\/Desktop\/workstep\/\.workstep\/visualizations\/stage-progress-card-prototypes\.html"/,
  )
  assert.match(html, />stage-progress-card-prototypes\.html</)
  assert.doesNotMatch(html, /visualize\{/)
})
