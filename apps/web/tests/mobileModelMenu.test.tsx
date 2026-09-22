import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import FloatingMenu from '../src/components/FloatingMenu'
import { I18nProvider } from '../src/i18n'

test('phone model picker is a sheet and selecting a model calls the existing action once', async () => {
  const window = new Window({ width: 390, url: 'http://localhost/chat' })
  Object.assign(globalThis, { window, document: window.document, history: window.history, IS_REACT_ACT_ENVIRONMENT: true })
  const selected: string[] = []
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root.render(<I18nProvider><FloatingMenu title="选择模型" anchor={{ left: 330, top: 750, width: 40, height: 44 }} options={[{ value: 'model-a', label: '模型 A' }, { value: 'model-b', label: '模型 B' }]} value="model-a" onSelect={value => selected.push(value)} onClose={() => {}} /></I18nProvider>))
  assert.ok(document.querySelector('.mobile-sheet'))
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('模型 B'))!.click())
  assert.deepEqual(selected, ['model-b'])
  await act(async () => root.unmount())
  await window.happyDOM.close()
})
