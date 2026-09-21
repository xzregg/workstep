import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import StagePromptVariablesHint from '../src/components/StagePromptVariablesHint'

test('stage prompt variable hint lists every supported placeholder', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <StagePromptVariablesHint />
        </I18nProvider>,
      )
    })

    const text = container.textContent || ''
    for (const variable of [
      '{name}',
      '{trigger_name}',
      '{creator_name}',
      '{task_creator_name}',
      '{task_title}',
      '{task_description}',
      '{stage_name}',
      '{stage_key}',
    ]) {
      assert.match(text, new RegExp(variable.replace(/[{}]/g, '\\$&')))
    }
    assert.match(text, /执行时|runtime/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
