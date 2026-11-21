import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

test('audio worklet batches 20ms and flushes every last sample before acknowledgement', () => {
  const messages: any[] = []
  let Processor: any
  class Base {
    port = { onmessage: null as any, postMessage: (data: any) => messages.push(data) }
  }
  runInNewContext(readFileSync(new URL('../src/audio/voiceCapture.worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, sampleRate: 48000,
    registerProcessor: (_name: string, implementation: any) => { Processor = implementation },
  })
  const processor = new Processor()
  for (let offset = 0; offset < 48123; offset += 128) {
    const frame = Float32Array.from({ length: Math.min(128, 48123-offset) }, (_, i) => offset+i)
    assert.equal(processor.process([[frame]]), true)
  }
  assert.ok(messages.length <= 51, 'must not send hundreds of tiny messages per second')
  processor.port.onmessage({ data: { type: 'flush' } })
  assert.equal(messages.at(-1).type, 'flushed')
  const audio = messages.filter(item => ArrayBuffer.isView(item)).flatMap(item => Array.from(item))
  assert.equal(audio.length, 48123)
  assert.deepEqual(audio, Array.from({ length: 48123 }, (_, i) => i))
  processor.port.onmessage({ data: { type: 'flush' } })
  assert.equal(messages.filter(item => ArrayBuffer.isView(item)).length, 51)
})

test('audio worklet reports a gap before delivering samples from the resumed device', () => {
  const messages: any[] = []
  let Processor: any
  const sandbox = {
    AudioWorkletProcessor: class {
      port = { onmessage: null as any, postMessage: (data: any) => messages.push(data) }
    },
    sampleRate: 48000, currentFrame: 0,
    registerProcessor: (_name: string, implementation: any) => { Processor = implementation },
  }
  runInNewContext(readFileSync(new URL('../src/audio/voiceCapture.worklet.js', import.meta.url), 'utf8'), sandbox)
  const processor = new Processor()
  processor.process([[new Float32Array(128).fill(1)]])
  sandbox.currentFrame = 256
  processor.process([[new Float32Array(128).fill(2)]])
  processor.port.onmessage({ data: { type: 'flush' } })
  assert.deepEqual(messages.map(message => message.type ?? message[0]), [1, 'discontinuity', 2, 'flushed'])
})
