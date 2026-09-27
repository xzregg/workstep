import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SidebarRenameField from '../src/components/SidebarRenameField'
import { I18nProvider } from '../src/i18n'

test('sidebar rename validates whitespace and keeps the editor open after a failed save', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let attempts = 0
  let closed = false
  const saved: string[] = []
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter)

  try {
    await act(async () => root.render(
      <I18nProvider>
        <SidebarRenameField
          kind="project"
          initialName="Old"
          onSave={async (name) => {
            attempts += 1
            if (attempts === 1) throw new Error('try again')
            saved.push(name)
          }}
          onClose={() => { closed = true }}
        />
      </I18nProvider>,
    ))
    const input = container.querySelector('input') as HTMLInputElement
    assert.ok(input)
    const change = async (value: string) => act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const enter = async () => act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    await change('Bad name')
    assert.equal(input.getAttribute('aria-invalid'), 'true')
    await enter()
    assert.match(container.textContent || '', /Name cannot contain whitespace/)
    assert.equal(attempts, 0)
    await change('New')
    await enter()
    assert.match(container.textContent || '', /try again/)
    assert.equal(closed, false)
    await enter()
    assert.deepEqual(saved, ['New'])
    assert.equal(closed, true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
