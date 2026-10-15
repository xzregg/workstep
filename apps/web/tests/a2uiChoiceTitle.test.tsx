import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import A2uiMessage from '../src/components/A2uiMessage'

const { window } = installDomEnvironment()
const previousStyleSheet = Object.getOwnPropertyDescriptor(globalThis, 'CSSStyleSheet')
Object.defineProperty(globalThis, 'CSSStyleSheet', { configurable: true, value: window.CSSStyleSheet })
after(async () => {
  await window.happyDOM.close()
  if (previousStyleSheet) Object.defineProperty(globalThis, 'CSSStyleSheet', previousStyleSheet)
  else Reflect.deleteProperty(globalThis, 'CSSStyleSheet')
})

async function renderChoices(messages: Record<string, unknown>[]) {
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<A2uiMessage content="" messages={messages} />))
    return element.innerHTML
  } finally {
    await act(async () => root.unmount())
    element.remove()
  }
}

for (const variant of ['mutuallyExclusive', 'multipleSelection']) {
  for (const field of ['title', 'question', 'label']) {
    test(`A2UI ${variant} renders its ${field} above the options`, async () => {
      const messages = [
        { version: 'v0.9.1', createSurface: { surfaceId: 'survey', catalogId: '' } },
        { version: 'v0.9.1', updateComponents: { surfaceId: 'survey', components: [
          { component: 'ChoicePicker', id: 'root', variant, [field]: '哪些方面让你不满意？',
            value: [], displayStyle: 'chips', options: [{ label: '沟通管理', value: 'management' }] },
        ] } },
      ]
      const html = await renderChoices(messages)
      assert.match(html, /<strong[^>]*>哪些方面让你不满意？<\/strong>/)
      assert.ok(html.indexOf('哪些方面让你不满意？') < html.indexOf('沟通管理'))
    })
  }
}

test('A2UI choice title aliases preserve an explicit label', async () => {
  const messages = [
    { version: 'v0.9.1', createSurface: { surfaceId: 'survey', catalogId: '' } },
    { version: 'v0.9.1', updateComponents: { surfaceId: 'survey', components: [
      { component: 'ChoicePicker', id: 'root', label: '当前问题', title: '旧标题', question: '旧问题',
        value: [], options: [{ label: '选项', value: 'option' }] },
    ] } },
  ]
  const html = await renderChoices(messages)
  assert.match(html, /当前问题/)
  assert.doesNotMatch(html, /旧标题|旧问题/)
})
