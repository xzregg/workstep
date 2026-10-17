import './helpers/domEnv'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createFeatureStorage } from '../src/skins/featureStorage'
import { ExtensionSession } from '../src/skins/extensions'
import { defaultSkin, compileSkin } from '../src/skins/contract'
import { registerSkinActions, executeSkinAction, skinActionEnabled } from '../src/skins/actions'
Object.assign(globalThis, { indexedDB, IDBKeyRange })

test('v2 CSS follows ordinary overrides; composer positions and effects validate', () => {
  const skin = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'calendar', schema_version: 2 }, tokens: { bg: '#fafafa' }, css: '[data-ui="message"]{border:0}', layout: { composerPosition: 'left' as const } }
  assert.match(compileSkin(skin), /--bg:#fafafa;/)
  assert.ok(compileSkin(skin).endsWith(skin.css))
  assert.throws(() => compileSkin({ ...skin, layout: { composerPosition: 'somewhere' } } as never))
  assert.throws(() => compileSkin({ ...skin, effects: { charsPerSecond: 0 } }))
})

test('feature data survives session recreation and stays isolated by identity and feature', async () => {
  const first = createFeatureStorage('identity-a', 'calendar-skin', 'calendar')
  await first.set('events', [{ id: '1', title: '写方案' }])
  assert.deepEqual(await createFeatureStorage('identity-a', 'calendar-skin', 'calendar').get('events'), [{ id: '1', title: '写方案' }])
  assert.equal(await createFeatureStorage('identity-b', 'calendar-skin', 'calendar').get('events'), undefined)
  assert.equal(await createFeatureStorage('identity-a', 'calendar-skin', 'notes').get('events'), undefined)
  const backup = await first.export()
  const other = createFeatureStorage('identity-a', 'another-skin', 'calendar')
  await other.import(backup)
  assert.deepEqual(await other.get('events'), await first.get('events'))
  await assert.rejects(() => other.import({ ...backup, entries: [['valid', 'new'], [123, 'invalid']] } as never))
  assert.equal(await other.get('valid'), undefined, 'failed import must be atomic')
  await first.delete('events')
  assert.equal(await first.get('events'), undefined)
})

test('extension activation and disposal clean registrations, including late async activation', async () => {
  const skin = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'calendar', schema_version: 2 }, revision: 'one', script: 'theme.js', file_base: '/api/skins/files/one' }
  const session = new ExtensionSession(skin, 'identity-a')
  let cleaned = 0
  await session.activate(async () => ({ activate(api) {
    api.features.register({ id: 'calendar', title: '日历', render: () => null })
    api.slots.register({ id: 'clock', title: '时钟', slot: 'workspace-right', render: () => null })
    api.actions.register('custom', () => 42)
    return () => { cleaned++ }
  } }))
  assert.equal(session.snapshot().features.length, 1)
  assert.equal(await session.execute('custom'), 42)
  session.dispose()
  session.dispose()
  assert.equal(cleaned, 1)
  assert.equal(session.snapshot().features.length, 0)
  await assert.rejects(() => session.execute('custom'))
  let finish!: (module: { activate: () => () => void }) => void
  const late = new ExtensionSession(skin, 'identity-a')
  const activating = late.activate(() => new Promise(resolve => { finish = resolve }))
  late.dispose()
  finish({ activate: () => () => { cleaned++ } })
  await activating
  assert.equal(late.snapshot().features.length, 0)
  assert.equal(cleaned, 1, 'disposed session must not execute a late module')
})

test('activation failure cleans partially registered contributions', async () => {
  const session = new ExtensionSession({ ...defaultSkin(), file_base: '/api/skins/files/one' }, 'identity-a')
  await assert.rejects(() => session.activate(async () => ({ activate(api) {
    api.features.register({ id: 'notes', title: '便签', render: () => null })
    throw new Error('broken extension')
  } })))
  assert.equal(session.snapshot().features.length, 0)
})

test('context actions enforce availability and restore the underlying conversation on disposal', async () => {
  let editable = false
  const dispose = registerSkinActions({ 'chat.send': { run: () => 'first', enabled: () => editable } })
  try {
    assert.equal(skinActionEnabled('chat.send'), false)
    await assert.rejects(() => executeSkinAction('chat.send'))
    editable = true
    assert.equal(await executeSkinAction('chat.send'), 'first')
    const overlay = registerSkinActions({ 'chat.send': { run: () => 'overlay' } })
    assert.equal(await executeSkinAction('chat.send'), 'overlay')
    overlay()
    assert.equal(await executeSkinAction('chat.send'), 'first')
  } finally { dispose() }
  assert.equal(skinActionEnabled('chat.send'), false)
})
