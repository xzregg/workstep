import { createKeywordSpotter } from '@sherpaw/kws'
import type { VoiceWakeDraft } from '../api/digitalPerson'
import modelUrl from './wake-model/zh-en-int8.data?url&no-inline'
import lexiconUrl from './wake-model/en.phone?url&no-inline'
import vocabulary from './wake-model/tokens.txt?raw'
import metadata from './wake-model/metadata.json'
import { encodeWakePhrase } from './wakeWordTokens'

const thresholds = { low: 0.5, balanced: 0.25, high: 0.15 }
const tokens = new Set(vocabulary.trim().split('\n').map(line => line.split(' ')[0]))

async function fetchAsset(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('voiceWake.loadFailed')
  return response
}

let modelData: Promise<ArrayBuffer> | undefined
export function preloadWakeWord() {
  if (modelData) return modelData
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40000)
  modelData = fetchAsset(modelUrl, controller.signal)
    .then(response => response.arrayBuffer())
    .catch(error => { modelData = undefined; throw error })
    .finally(() => clearTimeout(timer))
  return modelData
}

export async function openWakeWord(config: VoiceWakeDraft, signal: AbortSignal) {
  const lexicon = new Map<string, string[]>()
  const phrase = config.keyword.normalize('NFKC')
  if (/[a-z]/i.test(phrase)) {
    const words = new Set(phrase.toUpperCase().match(/[A-Z]+(?:'[A-Z]+)*/g))
    const text = await (await fetchAsset(lexiconUrl, signal)).text()
    for (const line of text.split('\n')) {
      const [word, ...phones] = line.trim().split(/\s+/)
      if (words.has(word)) lexicon.set(word, phones)
    }
  }
  const encoded = encodeWakePhrase(phrase, tokens, lexicon)
  const data = await preloadWakeWord()
  signal.throwIfAborted()
  const worker = new Worker(new URL('./wakeWord.worker.ts', import.meta.url), { type: 'module' })
  const spotter = await createKeywordSpotter({
    signal,
    model: { data, metadata },
    keywords: [{
      label: 'wake',
      matches: [{ tokens: encoded }],
      threshold: thresholds[config.sensitivity],
    }],
  }, { worker })
  return {
    async matches(pcm: Int16Array) {
      const audio = Float32Array.from(pcm, value => value / 32768)
      return (await spotter.processAudio(audio, 16000)).length > 0
    },
    reset: () => spotter.reset(),
    close: () => spotter.dispose(),
  }
}
