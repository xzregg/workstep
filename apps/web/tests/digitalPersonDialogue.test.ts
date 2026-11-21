import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnController } from '../src/audio/turnController'

test('sample-clock pause prepares a candidate and a checkpoint can veto submission', () => {
  const turn = new TurnController()
  let end = 0
  const frame = (probability: number) => turn.frame({ end: end += 512, probability })
  for (let index = 0; index < 3; index++) frame(0.53)
  assert.equal(turn.hasSpeech, true)
  for (let index = 0; index < 7; index++) frame(0.07)
  assert.equal(turn.candidate, false)
  frame(0.07)
  assert.equal(turn.candidate, true)
  const candidate = turn.lastVoice
  for (let index = 0; index < 11; index++) frame(0.07)
  assert.equal(turn.canCommit, true)
  frame(0.54)
  assert.equal(turn.canCommit, false)
  assert.notEqual(turn.lastVoice, candidate)
  for (let index = 0; index < 19; index++) frame(0.12)
  assert.equal(turn.canCommit, true)
})

test('short confident words survive while one-frame noise cannot start a turn', () => {
  const turn = new TurnController()
  turn.frame({ end: 512, probability: 0.98 })
  turn.frame({ end: 1024, probability: 0.08 })
  assert.equal(turn.hasSpeech, false)
  turn.frame({ end: 1536, probability: 0.86 })
  turn.frame({ end: 2048, probability: 0.91 })
  assert.equal(turn.hasSpeech, true)
  turn.frame({ end: 2560, probability: 0.36 })
  assert.equal(turn.lastVoice, 2560)
})

test('a capture gap keeps the utterance but requires a fresh confirmed pause', () => {
  const turn = new TurnController()
  let end = 0
  const frame = (probability: number) => turn.frame({ end: end += 512, probability })
  for (let index = 0; index < 3; index++) frame(.7)
  for (let index = 0; index < 19; index++) frame(.01)
  const previous = turn.snapshot()
  assert.equal(previous.canCommit, true)

  turn.discontinuity(end + 64)
  end += 64
  assert.equal(turn.hasSpeech, true)
  assert.equal(turn.candidate, false)
  assert.equal(turn.canCommit, false)
  assert.notEqual(turn.lastVoice, previous.lastVoice)
  for (let index = 0; index < 19; index++) frame(.01)
  assert.equal(turn.canCommit, true)
})
