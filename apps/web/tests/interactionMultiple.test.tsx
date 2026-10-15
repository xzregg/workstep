import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import InteractionPrompt from '../src/components/InteractionPrompt'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import type { InteractionRequestData } from '../src/utils/interaction'

for (const choicesKey of ['anyOf', 'oneOf', 'enum'] as const) {
  test(`ACP multiple choice ${choicesKey} selects, deselects and submits an array`, async () => {
    const { window } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const submitted: unknown[] = []
    const request: InteractionRequestData = {
      interaction_id: 'multi', method: 'elicitation/create', message: '请选择需要的功能',
      requested_schema: { type: 'object', required: ['features'], properties: {
        features: { type: 'array', title: '功能范围', items: choicesKey === 'enum'
          ? { type: 'string', enum: ['标题显示', '选项点击', '答案提交'] }
          : { [choicesKey]: ['标题显示', '选项点击', '答案提交'].map((value) => ({ const: value, title: value })) } },
      } },
    }
    try {
      await act(async () => root.render(<I18nProvider><InteractionPrompt request={request}
        onRespond={async (id, response) => { submitted.push({ id, response }) }} /></I18nProvider>))
      assert.ok(document.body.textContent?.includes('功能范围'))
      const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!
      const submit = button('提交回答')
      assert.equal(submit.disabled, true)
      await act(async () => button('标题显示').click())
      await act(async () => button('选项点击').click())
      assert.equal(button('标题显示').getAttribute('aria-pressed'), 'true')
      assert.equal(button('选项点击').getAttribute('aria-pressed'), 'true')
      assert.deepEqual(submitted, [])
      await act(async () => button('标题显示').click())
      assert.equal(button('标题显示').getAttribute('aria-pressed'), 'false')
      await act(async () => button('答案提交').click())
      await act(async () => submit.click())
      assert.deepEqual(submitted, [{ id: 'multi', response: {
        action: 'accept', content: { features: ['选项点击', '答案提交'] },
      } }])
      assert.equal(document.querySelectorAll('button').length, 0)
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}
