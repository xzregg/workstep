import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import { connectorApi } from '../src/api/connectors'
import { useProjectStore } from '../src/stores/projectStore'
import ConnectorEditor from '../src/components/connectors/ConnectorEditor'

test('project scope starts compact, supports multiple dropdown choices and removable tags', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  const oldProjects = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'p1', name: '项目甲' }, { id: 'p2', name: '项目乙' }] as never })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const oldSave = connectorApi.save
  let savedIds: string[] | undefined
  connectorApi.save = async value => { savedIds = value.project_ids; return value as never }
  try {
    await act(async () => root.render(<I18nProvider><ConnectorEditor initial={{ name: 'Demo', url: 'https://example.com/mcp' }} onClose={() => {}} onSaved={() => {}} /></I18nProvider>))
    assert.equal(document.querySelectorAll('.connector-project-tag').length, 0)
    assert.equal(document.querySelectorAll('.connector-projects input[type=checkbox]').length, 0)
    const dropdown = document.querySelector<HTMLButtonElement>('.connector-projects [role=combobox]')!
    assert.ok(dropdown)
    await act(async () => dropdown.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role=option][data-value=p1]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[role=option][data-value=p2]')!.click())
    assert.equal(document.querySelectorAll('.connector-project-tag').length, 2)
    await act(async () => document.querySelector<HTMLButtonElement>('[role=combobox][aria-expanded=true]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    for (const tag of [...document.querySelectorAll<HTMLButtonElement>('.connector-project-tag')]) await act(async () => tag.click())
    assert.equal(document.querySelectorAll('.connector-project-tag').length, 0)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(savedIds, [], 'removing the last tag restores all projects')
  } finally {
    connectorApi.save = oldSave
    await act(async () => root.unmount())
    useProjectStore.setState(oldProjects)
    await window.happyDOM.close()
  }
})

test('argument placeholder shows JSON without saving it, accepts pasted arrays and keeps line input', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const oldSave = connectorApi.save
  const saved: string[][] = []
  connectorApi.save = async value => { saved.push(value.args || []); return value as never }
  try {
    await act(async () => root.render(<I18nProvider><ConnectorEditor initial={{ name: 'Local', kind: 'mcp', transport: 'stdio', command: 'npx' }} onClose={() => {}} onSaved={() => {}} /></I18nProvider>))
    assert.equal(document.querySelector('.connector-editor textarea'), null, 'visual rows are the default')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-connector-args-source]')!.click())
    const args = document.querySelector<HTMLTextAreaElement>('.connector-editor textarea')!
    assert.ok(Array.isArray(JSON.parse(args.placeholder)))
    assert.equal(args.value, '')
    const save = document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!
    await act(async () => save.click())
    assert.deepEqual(saved[0], [])
    const input = async (text: string) => act(async () => {
      const current = document.querySelector<HTMLTextAreaElement>('.connector-editor textarea')!
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(current, text)
      current.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await input('["-y", "example-server", "/project with spaces"]')
    await act(async () => save.click())
    assert.deepEqual(saved[1], ['-y', 'example-server', '/project with spaces'])
    await input('-y\nexample-server\n/project with spaces')
    await act(async () => save.click())
    assert.deepEqual(saved[2], saved[1])
    await act(async () => document.querySelector<HTMLButtonElement>('.connector-edit-mode button')!.click())
    assert.deepEqual([...document.querySelectorAll<HTMLInputElement>('.connector-argument-row input')].map(element => element.value), saved[1])
    await act(async () => document.querySelector<HTMLButtonElement>('[data-connector-args-source]')!.click())
    await input('["unfinished"')
    assert.equal(save.disabled, true)
  } finally {
    connectorApi.save = oldSave
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('visual arguments and bearer authentication produce the existing connector schema', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const oldSave = connectorApi.save
  const writes: Record<string, unknown>[] = []
  connectorApi.save = async value => { writes.push(value); return value as never }
  const input = async (element: HTMLInputElement, text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<I18nProvider><ConnectorEditor initial={{ name: 'Demo', url: 'https://example.com/mcp' }} onClose={() => {}} onSaved={() => {}} /></I18nProvider>))
    const auth = document.querySelector<HTMLSelectElement>('.connector-authentication select')!
    await act(async () => { auth.value = 'bearer'; auth.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.disabled, true)
    const token = document.querySelector<HTMLInputElement>('.connector-token-input')!
    assert.equal(token.type, 'password')
    await input(token, 'example-only-token')
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(writes[0].headers, { Authorization: 'Bearer example-only-token' })
    await act(async () => document.querySelector<HTMLButtonElement>('[data-connector-mode=local]')!.click())
    await input(document.querySelector<HTMLInputElement>('.connector-command-input')!, 'npx')
    for (const argument of ['-y', 'example-server']) {
      await act(async () => document.querySelector<HTMLButtonElement>('.connector-add-row')!.click())
      const inputs = document.querySelectorAll<HTMLInputElement>('.connector-argument-row input')
      await input(inputs[inputs.length - 1], argument)
    }
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(writes[1].args, ['-y', 'example-server'])
    assert.equal(writes[1].transport, 'stdio')
  } finally {
    connectorApi.save = oldSave
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('editing saved authentication preserves credentials and SSE, none explicitly removes headers', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1280, height: 900 })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const oldSave = connectorApi.save
  const writes: Record<string, unknown>[] = []
  connectorApi.save = async value => { writes.push(value); return value as never }
  try {
    await act(async () => root.render(<I18nProvider><ConnectorEditor initial={{ id: 'demo', revision: 1, name: 'Existing', url: 'https://example.com/sse', transport: 'sse', has_credentials: true, header_names: ['Authorization'], env_names: [] }} onClose={() => {}} onSaved={() => {}} /></I18nProvider>))
    assert.equal(document.querySelector('.connector-token-input'), null)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-connector-mode=remote]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.equal(Object.hasOwn(writes[0], 'headers'), false)
    assert.equal(writes[0].transport, 'sse')
    const auth = document.querySelector<HTMLSelectElement>('.connector-authentication select')!
    await act(async () => { auth.value = 'none'; auth.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(writes[1].headers, {})
  } finally {
    connectorApi.save = oldSave
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
