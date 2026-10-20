import './helpers/domEnv'
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

// Shape returned by the workflow assistant: omitted version/value, chips alias,
// and a Button text instead of a child reference. Keep this fixture anonymous.
const messages = [
  { createSurface: { surfaceId: 'promotion_scope', catalogId: 'default' } },
  { updateComponents: { surfaceId: 'promotion_scope', components: [
    { id: 'root', component: 'Column', children: ['channels', 'mode', 'submit'] },
    { id: 'channels', component: 'TextField', label: '在哪些渠道推广？', variant: 'longText' },
    { id: 'mode', component: 'ChoicePicker', label: '推广内容如何发布？', variant: 'chips', options: [
      { label: '审核后发布', value: 'review' },
      { label: '自动发布', value: 'automatic' },
    ] },
    { id: 'submit', component: 'Button', text: '生成简化方案', action: { event: {
      name: 'submit_promotion_scope', context: {
        channels: { path: '/a2ui/promotion_scope/channels/value' },
        mode: { path: '/a2ui/promotion_scope/mode/value' },
      },
    } } },
  ] } },
]

for (const source of ['fence', 'events'] as const) {
  test(`workflow clarification renders and submits editable answers from ${source}`, async () => {
    const element = document.body.appendChild(document.createElement('div'))
    const root = createRoot(element)
    const actions: unknown[] = []
    try {
      await act(async () => root.render(<A2uiMessage
        content={source === 'fence' ? `\`\`\`a2ui\n${messages.map((m) => JSON.stringify(m)).join('\n')}\n\`\`\`` : ''}
        messages={source === 'events' ? messages : undefined}
        onAction={(action) => actions.push(action)}
      />))
      const button = (text: string) => {
        const found = [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)
        assert.ok(found, `missing ${text}: ${element.innerHTML}`)
        return found
      }
      const input = element.querySelector('textarea')
      assert.ok(input, 'channel input must be visible')
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '开发者社区')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      assert.equal(input.value, '开发者社区')
      await act(async () => button('审核后发布').click())
      assert.ok(button('审核后发布').classList.contains('selected'))
      await act(async () => button('生成简化方案').click())
      assert.equal(actions.length, 1)
      assert.deepEqual((actions[0] as { context: unknown }).context, { channels: '开发者社区', mode: ['review'] })
    } finally {
      await act(async () => root.unmount())
      element.remove()
    }
  })
}
