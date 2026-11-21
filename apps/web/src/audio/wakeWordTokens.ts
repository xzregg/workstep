import { pinyin } from 'pinyin-pro'

const initial = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcswy])/
const han = /^\p{Script=Han}+$/u

export function encodeWakePhrase(phrase: string, vocabulary: ReadonlySet<string>,
  english: ReadonlyMap<string, string[]>): string[] {
  const words = phrase.normalize('NFKC').replace(/[^\p{L}\p{N}']/gu, ' ')
    .match(/\p{Script=Han}+|[a-zA-Z]+(?:'[a-zA-Z]+)*|[^\s]/gu) ?? []
  const tokens = words.flatMap(word => {
    if (!han.test(word)) return english.get(word.toUpperCase()) ?? ['']
    return pinyin(word, { type: 'array' }).flatMap(syllable => {
      const onset = initial.exec(syllable)?.[0] ?? ''
      const final = syllable.slice(onset.length)
      return onset && final ? [onset, final] : [syllable]
    })
  })
  if (tokens.length < 2 || tokens.some(token => !vocabulary.has(token))) {
    throw new Error('voiceWake.unsupportedKeyword')
  }
  return tokens
}
