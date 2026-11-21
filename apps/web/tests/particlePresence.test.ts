import test from 'node:test'
import assert from 'node:assert/strict'
import {createParticleCloud} from '../src/components/digital-person/avatar/particleCloud'
import {coreDrop,shellOrigin} from '../src/components/digital-person/avatar/presenceShell'

test('built-in call presence keeps a core, filaments and an enclosing particle cloud',()=>{
  const cloud=createParticleCloud()
  assert.deepEqual(cloud,createParticleCloud())
  const ids=new Set<number>()
  for(let i=0;i<cloud.length;i+=6){
    ids.add(cloud[i+3])
    assert.ok(Number.isFinite(cloud[i]+cloud[i+1]+cloud[i+2]))
  }
  assert.deepEqual([...ids].sort((a,b)=>a-b),[3,4,5,6,8,10,11,12])
  assert.ok(cloud.length/6<26000)
})

test('the low-cost cloud keeps every particle layer at less than half the vertex count',()=>{
  const desktop=createParticleCloud()
  const mobile=createParticleCloud(true)
  assert.ok(mobile.length<desktop.length/2)
  assert.deepEqual(mobile,createParticleCloud(true))
  const ids=new Set<number>()
  for(let i=3;i<mobile.length;i+=6)ids.add(mobile[i])
  assert.deepEqual([...ids].sort((a,b)=>a-b),[3,4,5,6,8,10,11,12])
})

test('body particles fill all eight octants and stay within the spherical silhouette',()=>{
  for(const [lightweight,budget] of [[false,52000],[true,24000]] as const){
    const cloud=createParticleCloud(lightweight)
    assert.ok(cloud.length/3<budget)
    const octants=Array.from({length:8},()=>0)
    const filaments=[]
    let interior=0
    for(let i=0;i<cloud.length;i+=6){
      const x=cloud[i]-shellOrigin[0],y=cloud[i+1]-shellOrigin[1],z=cloud[i+2]
      if(cloud[i+3]===5)filaments.push(Math.hypot(x,y+coreDrop,z))
      if(cloud[i+3]<10)continue
      const radius=Math.hypot(x,y,z)
      assert.ok(radius<.70)
      if(cloud[i+3]!==10)continue
      if(radius>.53)octants[(x>0?1:0)+(y>0?2:0)+(z>0?4:0)]++
      if(radius<.44)interior++
    }
    assert.ok(octants.every(count=>count>100))
    assert.ok(interior>400)
    assert.ok(Math.min(...filaments)<.10)
    assert.ok(Math.max(...filaments)>.52)
  }
})

import {orbPhaseFor} from '../src/components/digital-person/avatar/particlePalette'
test('call phase shows generation while the microphone remains open',()=>{
  const base={playing:false,outputBusy:false,microphoneOn:false,voicePhase:'idle',sending:false,muted:false,error:false,checking:false,phase:'thinking' as const}
  const standby={...base,phase:'idle' as const,waitingForWake:true}
  assert.equal(orbPhaseFor(standby),'wake')
  assert.equal(orbPhaseFor({...standby,waitingForWake:false}),'idle')
  assert.equal(orbPhaseFor({...standby,microphoneOn:true}),'listening')
  assert.equal(orbPhaseFor({...standby,playing:true}),'playing')
  assert.equal(orbPhaseFor({...base,message:'waiting'}),'wait')
  assert.equal(orbPhaseFor({...base,message:'failed'}),'error')
  assert.equal(orbPhaseFor({...base,outputBusy:true}),'synth')
  assert.equal(orbPhaseFor({...base,outputBusy:true,playing:true}),'playing')
  assert.equal(orbPhaseFor({...base,microphoneOn:true,voicePhase:'finishing'}),'transcribe')
  assert.equal(orbPhaseFor({...base,phase:'working'}),'work')
  assert.equal(orbPhaseFor({...base,phase:'working',microphoneOn:true}),'work')
  assert.equal(orbPhaseFor({...base,phase:'replying',microphoneOn:true}),'write')
  assert.equal(orbPhaseFor({...base,microphoneOn:true}),'thinking')
})
