import './helpers/domEnv'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantChatPanel from '../src/components/AssistantChatPanel'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

const { window } = installDomEnvironment()
const previousStyleSheet = Object.getOwnPropertyDescriptor(globalThis, 'CSSStyleSheet')
Object.defineProperty(globalThis, 'CSSStyleSheet', { configurable: true, value: window.CSSStyleSheet })
after(async () => {
  await window.happyDOM.close()
  if (previousStyleSheet) Object.defineProperty(globalThis, 'CSSStyleSheet', previousStyleSheet)
  else Reflect.deleteProperty(globalThis, 'CSSStyleSheet')
})

for (const customHandler of [false, true]) {
  test(`A2UI multi-select confirmation ${customHandler ? 'uses the custom handler' : 'sends answers without modifying the draft'}`, async () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    const element = document.body.appendChild(document.createElement('div'))
    const root = createRoot(element)
    const sent: string[] = []
    const drafts: string[] = []
    const actions: unknown[] = []
    const messages = [
      { version: 'v0.9.1', createSurface: { surfaceId: 'multi', catalogId: '' } },
      { version: 'v0.9.1', updateComponents: { surfaceId: 'multi', components: [
        { component: 'Column', id: 'root', children: ['features', 'submit'] },
        { component: 'ChoicePicker', id: 'features', label: '测试哪些功能？', variant: 'multipleSelection', displayStyle: 'chips', value: [],
          options: ['标题显示', '选项点击'].map((value) => ({ label: value, value })) },
        { component: 'Text', id: 'submit-label', text: '确认提交' },
        { component: 'Button', id: 'submit', child: 'submit-label', action: { event: { name: 'submit_form',
          context: { '测试项目': { path: '/a2ui/multi/features/value' } } } } },
      ] } },
    ]
    try {
      await act(async () => root.render(<I18nProvider><AssistantChatPanel
        projectId="" title="Chat" messages={[{ id: 'multi-message', role: 'assistant', content: `\`\`\`a2ui\n${messages.map((message) => JSON.stringify(message)).join('\n')}\n\`\`\``, status: 'succeeded' }]}
        running={false} stopping={false} input="保留草稿" locale="zh-CN" config={{} as never}
        copy={{ emptyIntro: '', thinking: '', me: '用户', meInitials: 'U', agent: '助手', agentInitials: 'AI', placeholder: '', fullPrompt: '', closePrompt: '' }}
        attachmentPrefix="test" onInputChange={(value) => drafts.push(value)} onSend={() => {}} onStop={() => {}}
        onSendContent={async (value) => { sent.push(value); return true }}
        onA2uiAction={customHandler ? (action) => actions.push(action) : undefined}
      /></I18nProvider>))
      const button = (label: string) => {
        const found = [...element.querySelectorAll<HTMLButtonElement>('.a2ui-message button')].find((node) => node.textContent?.trim() === label)
        assert.ok(found, `${label}: ${element.querySelector('.a2ui-message')?.innerHTML}`)
        return found
      }
      await act(async () => button('标题显示').click())
      await act(async () => button('选项点击').click())
      assert.deepEqual(sent, [])
      await act(async () => button('确认提交').click())
      if (customHandler) {
        assert.equal(actions.length, 1)
        assert.deepEqual(sent, [])
      } else {
        assert.deepEqual(sent, ['已提交表单：测试项目：标题显示、选项点击'])
      }
      assert.deepEqual(drafts, [])
    } finally {
      await act(async () => root.unmount())
      element.remove()
    }
  })
}
