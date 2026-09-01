import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'


test('floating menus escape dialog clipping and render above the dialog backdrop', async () => {
  const floatingMenuSource = await readFile(
    new URL('../src/components/FloatingMenu.tsx', import.meta.url),
    'utf8',
  )
  const confirmDialogSource = await readFile(
    new URL('../src/components/ConfirmDialog.tsx', import.meta.url),
    'utf8',
  )

  assert.match(floatingMenuSource, /createPortal/)
  assert.match(floatingMenuSource, /document\.body/)
  const floatingLayer = Number(floatingMenuSource.match(/zIndex:\s*(\d+)/)?.[1])
  const dialogLayer = Number(confirmDialogSource.match(/zIndex:\s*(\d+)/)?.[1])
  assert.ok(floatingLayer > dialogLayer, `${floatingLayer} must be above ${dialogLayer}`)
})
