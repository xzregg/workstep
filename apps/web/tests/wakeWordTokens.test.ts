import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeWakePhrase } from '../src/audio/wakeWordTokens'

test('encodes configured Mandarin and English phrases into model tokens', () => {
  const allowed = new Set('n ǐ h ǎo x iǎo y án L AY1 T AH1 P'.split(' '))
  const english = new Map([['LIGHT', ['L', 'AY1', 'T']], ['UP', ['AH1', 'P']]])
  assert.deepEqual(encodeWakePhrase('你好小研', allowed, english), ['n', 'ǐ', 'h', 'ǎo', 'x', 'iǎo', 'y', 'án'])
  assert.deepEqual(encodeWakePhrase('Ｌｉｇｈｔ up!', allowed, english), ['L', 'AY1', 'T', 'AH1', 'P'])
  assert.throws(() => encodeWakePhrase('你好2026', allowed, english), /unsupportedKeyword/)
  assert.throws(() => encodeWakePhrase('hello', allowed, english), /unsupportedKeyword/)
})
