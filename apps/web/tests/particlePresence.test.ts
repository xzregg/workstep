import test from 'node:test'
import assert from 'node:assert/strict'
import {createParticleCloud} from '../src/components/digital-person/avatar/particleCloud'
import {coreDrop,shellOrigin} from '../src/components/digital-person/avatar/presenceShell'
import {createOrb} from '../src/components/digital-person/avatar/presenceOrb'

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
test('visible terminal poses keep flowing without making the stopped orb contract',()=>{
  const previousRatio=globalThis.devicePixelRatio
  globalThis.devicePixelRatio=1
  let orbit=0,scale=0
  const gl=new Proxy({
    getShaderParameter:()=>true,getProgramParameter:()=>true,getUniformLocation:(_:unknown,name:string)=>name,
    uniform1f:(name:string,value:number)=>{if(name==='t')orbit=value},
    uniform4f:(name:string,value:number)=>{if(name==='motion')scale=value},
  },{get:(target,key)=>Reflect.get(target,key)??(()=>{})})
  const canvas={getContext:()=>gl,getBoundingClientRect:()=>({width:320,height:320}),dataset:{}} as unknown as HTMLCanvasElement
  const renderer=createOrb(canvas,true)
  try{
    renderer.draw(33,'idle',0,false)
    const before=orbit
    for(let frame=0;frame<120;frame++) assert.equal(renderer.draw(33,'stopped',0,false),true)
    assert.ok(orbit>before)
    assert.equal(scale,1)
    for(const phase of ['wait','muted','error'] as const){
      const before=orbit
      for(let frame=0;frame<120;frame++) assert.equal(renderer.draw(33,phase,0,false),true)
      assert.ok(orbit>before)
    }
    assert.equal(renderer.draw(33,'stopped',0,true),false)
  }finally{
    renderer.dispose()
    globalThis.devicePixelRatio=previousRatio
  }
})

test('call phase shows generation while the microphone remains open',()=>{
  const base={playing:false,outputBusy:false,microphoneOn:false,voicePhase:'idle',sending:false,muted:false,error:false,checking:false,phase:'thinking' as const}
  const standby={...base,phase:'idle' as const,waitingForWake:true}
  assert.equal(orbPhaseFor(standby),'wake')
  assert.equal(orbPhaseFor({...standby,waitingForWake:false}),'idle')
  assert.equal(orbPhaseFor({...standby,microphoneOn:true}),'listening')
  const capturing={...standby,phase:'listening' as const,microphoneOn:true,voicePhase:'preparing'}
  assert.equal(orbPhaseFor(capturing),'listening')
  assert.equal(orbPhaseFor({...capturing,message:'stopped'}),'listening')
  assert.equal(orbPhaseFor({...capturing,message:'waiting'}),'wait')
  assert.equal(orbPhaseFor({...standby,playing:true}),'playing')
  assert.equal(orbPhaseFor({...standby,outputBusy:true}),'synth')
  assert.equal(orbPhaseFor({...standby,message:'stopped'}),'wake')
  assert.equal(orbPhaseFor({...standby,message:'failed',error:true,voicePhase:'error'}),'wake')
  assert.equal(orbPhaseFor({...standby,message:'waiting'}),'wake')
  assert.equal(orbPhaseFor({...standby,phase:'thinking',checking:true}),'wake')
  const rearming={...standby,waitingForWake:false,preparingWake:true}
  assert.equal(orbPhaseFor({...rearming,message:'stopped'}),'idle')
  assert.equal(orbPhaseFor({...rearming,message:'failed',error:true}),'idle')
  assert.equal(orbPhaseFor({...rearming,message:'waiting',playing:true}),'playing')
  assert.equal(orbPhaseFor({...rearming,preparingWake:false,message:'stopped'}),'stopped')
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

test('microphone volume expands the listening core while the outer shell keeps its pose',()=>{
  const previousRatio=globalThis.devicePixelRatio
  globalThis.devicePixelRatio=1
  let core=0,scale=0,output=0
  const gl=new Proxy({
    getShaderParameter:()=>true,getProgramParameter:()=>true,getUniformLocation:(_:unknown,name:string)=>name,
    uniform1f:(name:string,value:number)=>{
      if(name==='listenCore')core=value
      if(name==='energy')output=value
    },
    uniform4f:(name:string,value:number)=>{if(name==='motion')scale=value},
  },{get:(target,key)=>Reflect.get(target,key)??(()=>{})})
  const canvas={getContext:()=>gl,getBoundingClientRect:()=>({width:320,height:320}),dataset:{}} as unknown as HTMLCanvasElement
  const renderer=createOrb(canvas,true)
  try{
    renderer.draw(33,'listening',0,true)
    const resting=scale
    renderer.draw(33,'listening',0,false,.08)
    assert.ok(core>.17,'a soft syllable registers in one frame')
    for(let frame=0;frame<5;frame++)renderer.draw(33,'listening',0,false,.08)
    const quiet=core
    assert.ok(quiet>.15)
    for(let frame=0;frame<6;frame++)renderer.draw(33,'listening',0,false,.5)
    assert.ok(core>quiet+.40)
    const normal=core
    for(let frame=0;frame<6;frame++)renderer.draw(33,'listening',0,false,.85)
    assert.ok(core>normal+.10,'louder syllables retain headroom above normal speech')
    assert.equal(scale,resting)
    assert.equal(output,0)
    for(let frame=0;frame<7;frame++)renderer.draw(33,'listening',0,false,0)
    assert.ok(core<.05)
    renderer.draw(33,'listening',0,true,.5)
    assert.equal(core,0)
    renderer.draw(33,'playing',.5,false,.5)
    assert.equal(core,0)
    assert.ok(output>0)
  }finally{
    renderer.dispose()
    globalThis.devicePixelRatio=previousRatio
  }
})

test('presence enlarges the sphere by 32% within the existing canvas',()=>{
  const previousRatio=globalThis.devicePixelRatio
  globalThis.devicePixelRatio=1
  let fit:number[]=[]
  let viewport:number[]=[]
  let rect={width:320,height:320}
  const gl=new Proxy({
    getShaderParameter:()=>true,getProgramParameter:()=>true,getUniformLocation:(_:unknown,name:string)=>name,
    uniform2f:(name:string,x:number,y:number)=>{if(name==='fit')fit=[x,y]},
    viewport:(_x:number,_y:number,width:number,height:number)=>{viewport=[width,height]},
  },{get:(target,key)=>Reflect.get(target,key)??(()=>{})})
  const canvas={getContext:()=>gl,getBoundingClientRect:()=>rect,dataset:{}} as unknown as HTMLCanvasElement
  const renderer=createOrb(canvas,false)
  try{
    renderer.draw(33,'idle',0,true)
    assert.ok(fit.every(axis=>Math.abs(axis-1.188)<1e-9))
    assert.deepEqual(viewport,[320,320])
    rect={width:600,height:300}
    renderer.draw(33,'idle',0,true)
    assert.deepEqual(fit,[.66,1.32])
    assert.deepEqual(viewport,[600,300])
  }finally{
    renderer.dispose()
    globalThis.devicePixelRatio=previousRatio
  }
})
