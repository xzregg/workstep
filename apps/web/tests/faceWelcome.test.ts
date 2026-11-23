import assert from 'node:assert/strict'
import test from 'node:test'
import {FaceWelcomePresence} from '../src/components/face-recognition/faceWelcomePresence'

test('only stable return in the same stream qualifies, once per absence',()=>{
 const presence=new FaceWelcomePresence()
 const observe=(ids:(string|null)[],at:number)=>presence.observe(ids,at,2)
 const frames=(ids:(string|null)[],start:number,end:number)=>{
  const results=[]
  for(let at=start;at<=end;at+=500){const candidate=observe(ids,at);if(candidate)results.push(candidate)}
  return results
 }
 assert.deepEqual(frames(['a'],0,2000),[])
 assert.deepEqual(frames([],2500,4000),[])
 assert.deepEqual(frames(['a'],4500,6500),[])
 assert.deepEqual(frames([],7000,127000),[])
 assert.deepEqual(frames(['a'],127500,132000),['a'])
 assert.deepEqual(frames(['a'],140000,143000),[]) // frozen stream breaks observation
 assert.deepEqual(frames([],143500,265000),[])
 presence.reset()
 assert.deepEqual(frames(['a'],265500,270000),[])
})

test('unmatched and mixed faces cannot fake a return',()=>{
 const presence=new FaceWelcomePresence()
 const observe=(ids:(string|null)[],at:number)=>presence.observe(ids,at,2)
 for(let at=0;at<125000;at+=500)assert.equal(observe(at<2000?['a']:[null],at),null)
 for(let at=125000;at<129000;at+=500)assert.equal(observe(['a',null],at),null)
 for(let at=129000;at<134000;at+=500)assert.equal(observe(['a'],at),null)
})
