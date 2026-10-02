import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import FloatingMenu, { filterMenuOptions } from '../src/components/FloatingMenu'
import { I18nProvider } from '../src/i18n'

const MODELS = [
  { value: 'm1', label: 'GLM-4.7' },
  { value: 'm2', label: 'GLM-4.7-Flash' },
  { value: 'm3', label: 'Kimi-K2.5' },
  { value: 'm4', label: 'MiniMax-M2.1' },
  { value: 'm5', label: 'Qwen3-Max' },
  { value: 'm6', label: 'DeepSeek-V3.2' },
  { value: 'm7', label: 'GPT-5.2' },
  { value: 'm8', label: 'Claude-Sonnet-4.6' },
]

test('filterMenuOptions matches label case-insensitively', () => {
  assert.deepEqual(
    filterMenuOptions(MODELS, 'glm').map((option) => option.value),
    ['m1', 'm2'],
  )
})

test('filterMenuOptions matches description and value', () => {
  const options = [
    { value: 'gpt-5', label: 'GPT', description: 'OpenAI flagship' },
    { value: 'claude-x', label: 'Claude' },
  ]
  assert.deepEqual(filterMenuOptions(options, 'flagship').map((option) => option.value), ['gpt-5'])
  assert.deepEqual(filterMenuOptions(options, 'claude-x').map((option) => option.value), ['claude-x'])
})

test('filterMenuOptions returns everything on empty query and nothing on no match', () => {
  assert.equal(filterMenuOptions(MODELS, '  ').length, MODELS.length)
  assert.deepEqual(filterMenuOptions(MODELS, 'no-such-model-zzz'), [])
})

const window = new Window({ width: 1280, url: 'http://localhost/chat' })
Object.assign(globalThis, {
  window,
  document: window.document,
  history: window.history,
  IS_REACT_ACT_ENVIRONMENT: true,
})

let root: Root | null = null
let container: HTMLElement | null = null

async function renderMenu(options = MODELS, searchable?: boolean) {
  if (root) {
    await act(async () => root!.unmount())
    container?.remove()
  }
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <I18nProvider>
        <FloatingMenu
          anchor={{ left: 100, top: 200, width: 80, height: 30 }}
          options={options}
          value=""
          onSelect={() => {}}
          onClose={() => {}}
          searchable={searchable}
        />
      </I18nProvider>,
    )
  })
}

after(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  await window.happyDOM.close()
})

test('floating menu shows a search box when options exceed the threshold', async () => {
  await renderMenu()
  assert.ok(document.querySelector('.chat-input-menu-search input'))
  assert.equal(document.querySelectorAll('.chat-input-menu-item').length, MODELS.length)
})

test('floating menu hides the search box for short option lists', async () => {
  await renderMenu([
    { value: 'a', label: '允许一次' },
    { value: 'b', label: '拒绝' },
  ])
  assert.equal(document.querySelector('.chat-input-menu-search'), null)
  assert.equal(document.querySelectorAll('.chat-input-menu-item').length, 2)
})
