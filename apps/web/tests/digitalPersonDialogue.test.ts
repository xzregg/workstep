import test from 'node:test'
import assert from 'node:assert/strict'
import {DialogueTurnDetector} from '../src/components/digital-person/dialogueTurnDetector'

test('dialogue waits for actual speech and sustained silence, then finishes a turn only once',()=>{
 const d=new DialogueTurnDetector()
 assert.equal(d.frame(0,0),undefined)
 assert.equal(d.tick(5000),'none')
 assert.equal(d.frame(.1,5100),undefined)
 assert.equal(d.frame(0,5500),undefined)
 assert.equal(d.tick(5900),'none')
 assert.equal(d.tick(6300),'finish')
 assert.equal(d.tick(8000),'none')
})
test('continuous sound only delays turn completion and never requests interruption',()=>{
 const d=new DialogueTurnDetector()
 for(const time of [0,500,1000,1500])assert.equal(d.frame(.6,time),undefined)
 assert.equal(d.tick(2000),'none')
 assert.equal(d.tick(2600),'finish')
 d.reset();assert.equal(d.tick(9000),'none')
})

test('a brief click and silent ASR hallucination cannot become an utterance',()=>{
 const d=new DialogueTurnDetector()
 const pcm=new Int16Array(8000);for(let i=0;i<320;i++)pcm[i]=6000
 d.observe(pcm,500)
 assert.equal(d.accepts('谢谢观看'),false)
 assert.equal(d.tick(3000),'none')
 d.reset()
 const speech=new Int16Array(8000);for(let i=0;i<speech.length;i++)speech[i]=Math.sin(i*.1)*3000
 d.observe(speech,500)
 assert.equal(d.accepts('嗯'),true,'short meaningful acknowledgements remain valid')
 assert.equal(d.accepts('……'),false)
 assert.equal(d.tick(1500),'finish')
})
