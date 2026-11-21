import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createAvatarSnapshot,createAvatarSource,getAvatarState,subscribeAvatar,AVATAR_STATE_EVENT,AVATAR_AUDIO_EVENT} from '../src/avatars/runtime'
import {createMotionMixer} from '../src/avatars/motion'

test('public avatar events separate semantic transitions from real speech levels and isolate sessions',async()=>{
 const {window}=installDomEnvironment(),scope={projectId:'p',sessionId:'a'},source=createAvatarSource(scope),other=createAvatarSource({projectId:'p',sessionId:'b'})
 const events:any[]=[],semantic:any[]=[],audio:any[]=[]
 const stop=subscribeAvatar(event=>events.push(event),scope)
 window.addEventListener(AVATAR_STATE_EVENT,event=>semantic.push((event as CustomEvent).detail))
 window.addEventListener(AVATAR_AUDIO_EVENT,event=>audio.push((event as CustomEvent).detail))
 try{
  const thought=source.update({phase:'thinking'},100)
  assert.equal(thought.action,'raise-hand');assert.equal(thought.hands,'raised');assert.equal(thought.speech.level,0)
  const speaking=source.update({phase:'thinking',speaking:true,level:.6},200)
  assert.equal(speaking.phase,'speaking');assert.equal(speaking.action,'lower-hand');assert.equal(speaking.hands,'lowered')
  assert.equal(speaking.transition.from,'thinking');assert.ok(speaking.transition.durationMs>=400)
  const level=source.update({phase:'thinking',speaking:true,level:.3},250)
  assert.equal(level.sequence,speaking.sequence,'audio frames do not restart transitions')
  assert.equal(semantic.length,2);assert.equal(audio.length,2)
  other.update({phase:'working'},300)
  assert.equal(events.filter(event=>event.type==='state').length,2,'another session stays isolated')
  assert.equal(getAvatarState(scope)?.speech.level,.3)
  assert.equal(Object.isFrozen(level),true);assert.equal(Object.isFrozen(level.transition),true)
  const quiet=source.update({phase:'idle',speaking:false,level:.9},400)
  assert.equal(quiet.speech.level,0,'no mouth animation without real playback')
  const reduced=source.update({phase:'thinking',reducedMotion:true},500)
  assert.equal(reduced.transition.durationMs,0)
 }finally{stop();source.dispose();other.dispose();await window.happyDOM.close()}
 assert.equal(getAvatarState(scope),null)
})
test('motion blending is time based and interruptions continue from the displayed pose',()=>{
 const track=createMotionMixer([0,0])
 assert.deepEqual([...track.sample([1,.5],'think',0,600)],[0,0])
 const halfway=[...track.sample([1,.5],'think',300,600)]
 assert.deepEqual(halfway,[.5,.25])
 assert.deepEqual([...track.sample([0,0],'speak',300,600)],halfway,'interruption has no jump')
 const lowered=track.sample([0,0],'speak',600,600)
 assert.deepEqual([...lowered],[.25,.125])
 assert.deepEqual([...track.sample([0,0],'speak',900,600)],[0,0])
 const slow=createMotionMixer([0]),fast=createMotionMixer([0])
 slow.sample([1],'a',0,600);fast.sample([1],'a',0,600)
 for(let t=20;t<300;t+=20)fast.sample([1],'a',t,600)
 assert.equal(slow.sample([1],'a',300,600)[0],fast.sample([1],'a',300,600)[0])
 assert.equal(slow.sample([0],'reduced',301,0)[0],0)
})

test('affinity is a read-only scoped skin input with unknown distinct from zero',()=>{
 const scope={projectId:'p',sessionId:'a'}
 const a=createAvatarSnapshot(scope,{phase:'idle'},null,0)
 assert.equal(a.affinity,null)
 const b=createAvatarSnapshot(scope,{phase:'idle',affinity:120},a,1)
 assert.equal(b.affinity,100);assert.ok(b.sequence>a.sequence)
 const c=createAvatarSnapshot(scope,{phase:'idle',affinity:100},b,2)
 assert.equal(b,c)
})

test('skins receive wake state changes and microphone frames separately from speech',async()=>{
 const {window}=installDomEnvironment(),scope={projectId:'p',sessionId:'wake'},source=createAvatarSource(scope)
 const events:string[]=[]
 const off=subscribeAvatar(event=>events.push(event.type),scope)
 try{
  source.update({phase:'idle'})
  const wake=source.update({phase:'idle',callState:'waitingForWake'})
  assert.equal(wake.callState,'waitingForWake')
  const listening=source.update({phase:'listening',callState:'listening'})
  const frame=source.update({phase:'listening',callState:'listening',inputLevel:.6})
  assert.equal(frame.inputLevel,.6)
  assert.equal(frame.sequence,listening.sequence)
  assert.deepEqual(events,['state','state','state','audio'])
  const system=source.update({phase:'speaking',speaking:true,level:.9,metered:false})
  assert.deepEqual(system.speech,{playing:true,level:0,metered:false})
 }finally{off();source.dispose();await window.happyDOM.close()}
})
