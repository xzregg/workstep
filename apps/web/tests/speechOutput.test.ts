import test from 'node:test'
import assert from 'node:assert/strict'
import { takeSpeechSentences, speechText } from '../src/utils/speechOutput'
import { SpeechOutputPlayer } from '../src/utils/speechOutput'
import { speechOutputApi } from '../src/api/speechOutput'
import { outputStatus } from './fixtures/speechOutput'

test('sentence segmentation preserves partial output, consumes each sentence once and flushes tail', () => {
  assert.deepEqual(takeSpeechSentences('你好。下一句', false), { sentences: ['你好。'], rest: '下一句' })
  assert.deepEqual(takeSpeechSentences('下一句完成！还有尾巴', true), { sentences: ['下一句完成！', '还有尾巴'], rest: '' })
  const long = '长'.repeat(300)
  const result = takeSpeechSentences(long, false)
  assert.ok(result.sentences.every(s => s.length <= 120))
  assert.equal(result.sentences.join('') + result.rest, long)
})

test('speech removes code and URLs without reading an unfinished streaming code block', () => {
  assert.equal(speechText('你好。\n```ts\nconsole.log(1)'), '你好。\n')
  assert.equal(speechText('看[结果](https://example.com)和![图片](image.png)。'), '看结果和。')
})

test('stop during session creation still collects and cancels the server session without fetching audio', async () => {
  const original = { ...speechOutputApi }
  let resolve!: (value: { id: string }) => void
  const cancelled: string[] = []
  speechOutputApi.start = () => new Promise(done => { resolve = done })
  speechOutputApi.cancel = async id => { cancelled.push(id) }
  speechOutputApi.next = async () => assert.fail('stopped playback must not fetch audio')
  try {
    const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' } })
    player.enqueue(['你好。'])
    player.stop()
    resolve({ id: 'owned-session' })
    await new Promise(done => setImmediate(done))
    assert.deepEqual(cancelled, ['owned-session'])
  } finally { Object.assign(speechOutputApi, original) }
})


test('ordinary playback uses saved server settings; only explicit preview sends a draft', async () => {
  const original = { ...speechOutputApi }
  const drafts: unknown[] = []
  speechOutputApi.start = async (_text, _project, draft) => { drafts.push(draft); return { id: 'session' } }
  speechOutputApi.next = async () => ({ done: true })
  speechOutputApi.cancel = async () => {}
  try {
    const settings = { ...outputStatus.settings, mode: 'remote' as const }
    new SpeechOutputPlayer({ settings, projectId: 'project' }).enqueue(['正常朗读'])
    await new Promise(done => setImmediate(done))
    new SpeechOutputPlayer({ settings, preview: true }).enqueue(['设置试听'])
    await new Promise(done => setImmediate(done))
    assert.deepEqual(drafts, [undefined, settings])
  } finally { Object.assign(speechOutputApi, original) }
})


for (const platform of ['WorkStepAndroid', 'WorkStepIOS']) test(`${platform} system playback uses native acknowledgements and cancels the owned utterance`, async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const sent: {type: string; id: string; text?: string}[] = []
  const bridge = { postMessage(message: string) { sent.push(JSON.parse(message)) }, onmessage: null as null | ((event: {data: string}) => void) }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { WorkStepSpeech: bridge, [platform]: {} } })
  try {
    const states: boolean[] = []
    const player = new SpeechOutputPlayer({ settings: outputStatus.settings, onState: state => states.push(state) })
    player.enqueue(['第一句。', '第二句。'])
    assert.equal(sent[0].text, '第一句。')
    bridge.onmessage!({ data: JSON.stringify({ id: sent[0].id, status: 'done' }) })
    await new Promise(done => setImmediate(done))
    assert.equal(sent[1].text, '第二句。')
    player.stop()
    assert.deepEqual(sent[2], { type: 'stop', id: sent[1].id })
    assert.equal(states.at(-1), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('queued short phrases coalesce and prepare one following synthesis before current audio completes',async()=>{
 const original={...speechOutputApi},started:string[]=[],cancelled:string[]=[]
 let release!:(value:any)=>void
 speechOutputApi.start=async text=>{started.push(text);return {id:`s${started.length}`}}
 speechOutputApi.next=async id=>id==='s1'?new Promise(resolve=>{release=resolve}):{done:true}
 speechOutputApi.cancel=async id=>{cancelled.push(id)}
 const player=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'},coalesce:true})
 try{
  player.enqueue(['第一句。']);await new Promise(resolve=>setImmediate(resolve))
  player.enqueue(['第二句。','第三句。']);await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(started,['第一句。','第二句。第三句。'],'one bounded lookahead synthesis, not one cold request per tiny sentence')
  release({done:true});await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(cancelled.sort(),['s1','s2'])
 }finally{player.stop();Object.assign(speechOutputApi,original)}
})

test('stop collects and cancels a late prefetched synthesis too',async()=>{
 const original={...speechOutputApi},cancelled:string[]=[]
 let ahead!:(value:{id:string})=>void,finish!:(value:any)=>void,count=0
 speechOutputApi.start=async()=>++count===1?{id:'current'}:new Promise(resolve=>{ahead=resolve})
 speechOutputApi.next=async()=>new Promise(resolve=>{finish=resolve})
 speechOutputApi.cancel=async id=>{cancelled.push(id)}
 const player=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'},coalesce:true})
 try{
  player.enqueue(['第一句']);await new Promise(resolve=>setImmediate(resolve))
  player.enqueue(['后一句']);await new Promise(resolve=>setImmediate(resolve))
  assert.equal(count,2)
  player.stop();ahead({id:'ahead'});finish({done:true})
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(cancelled.sort(),['ahead','current'])
 }finally{player.stop();Object.assign(speechOutputApi,original)}
})

test('voice gesture unlocks one output context reused after a turn stops',async()=>{
 const {primeSpeechOutput}=await import('../src/utils/speechOutput')
 const previous=globalThis.AudioContext;let created=0,closed=0,resumed=0
 class Context{state='running';constructor(){created++}resume(){resumed++;return Promise.resolve()}close(){closed++;return Promise.resolve()}}
 globalThis.AudioContext=Context as any
 try{
  primeSpeechOutput()
  const first=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'}})
  await first.unlock();first.stop()
  const next=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'}})
  await next.unlock();next.stop()
  assert.equal(created,1);assert.equal(closed,0);assert.ok(resumed>=3)
 }finally{globalThis.AudioContext=previous}
})
