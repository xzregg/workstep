import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const flowCanvasSource = await readFile(
  new URL('../src/components/FlowCanvas.tsx', import.meta.url),
  'utf8',
)

test('workflow and template editors can zoom out to ten percent', () => {
  assert.match(flowCanvasSource, /<ReactFlow[\s\S]*?minZoom=\{0\.1\}/)
})
