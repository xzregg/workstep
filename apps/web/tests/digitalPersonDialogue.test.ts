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

test('the visual speech gate ends during a pause and clears across a capture gap', () => {
  const turn = new TurnController()
  let end = 0
  const frame = (probability: number) => turn.frame({ end: end += 512, probability })
  assert.equal(turn.snapshot().recentSpeech, false)
  for (let index = 0; index < 3; index++) frame(.8)
  assert.equal(turn.snapshot().recentSpeech, true)
  frame(.02)
  frame(.02)
  assert.equal(turn.snapshot().recentSpeech, false)
  assert.equal(turn.snapshot().hasSpeech, true)
  assert.equal(turn.snapshot().canCommit, false)
  frame(.8)
  assert.equal(turn.snapshot().recentSpeech, true)
  turn.discontinuity(end)
  assert.equal(turn.snapshot().recentSpeech, false)
})


test('phone endpoint requires 1.8 seconds and resumed speech vetoes it',()=>{
 const turn=new TurnController(true)
 turn.frame({end:512,probability:.9});turn.frame({end:1024,probability:.9})
 turn.frame({end:1024+20480,probability:.01})
 assert.equal(turn.canCommit,false,'old 1.28 second cutoff must not commit')
 turn.frame({end:1024+28799,probability:.01})
 assert.equal(turn.canCommit,false)
 turn.frame({end:1024+28800,probability:.01})
 assert.equal(turn.canCommit,true)
 turn.frame({end:1024+29312,probability:.9})
 assert.equal(turn.canCommit,false)
})
