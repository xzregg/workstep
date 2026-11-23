import assert from 'node:assert/strict'
import test from 'node:test'
import type {MemoryKind} from '../src/api/digitalPerson'
import {galaxyFrame,initialGalaxyView,knowledgeSpiral} from '../src/components/digital-person/memoryGalaxy'

const frame=galaxyFrame(initialGalaxyView,0)
const kinds:MemoryKind[]=['preference','experience','fact','event']

test('the rotating disc sweeps opposite to the outward curve of the arms',()=>{
  const moving=galaxyFrame(initialGalaxyView,1)
  const disc=moving.belts.slice(0,-1)
  assert.ok(disc.every(({sin,cos})=>Math.atan2(sin,cos)<0))
})

function radiusOf(orbit:{position:(view:typeof frame)=>unknown}) {
  let radius=0
  orbit.position({...frame,project(x:number,z:number,height:number,belt:number){
    radius=Math.hypot(x,z)
    return frame.project(x,z,height,belt)
  }})
  return radius
}

test('even one memory kind fills all four arms with the same layout as a mixed catalogue',()=>{
  const stars=Array.from({length:80},(_,i)=>({
    id:'knowledge:'+(i+1),time:'2026-01-01T00:00:00Z',kind:'preference' as const,
  }))
  const orbits=knowledgeSpiral(stars)
  const mixed=knowledgeSpiral(stars.map((star,i)=>({...star,kind:kinds[i%kinds.length]})))
  for(const [id,orbit] of orbits)assert.deepEqual(orbit.position(frame),mixed.get(id)!.position(frame))
  const innermost=[...orbits.values()].slice(0,4)
  assert.ok(innermost.every(orbit=>radiusOf(orbit)<.24),'all four arms start near the core')
  const angles=innermost.map(({angle})=>angle).sort((a,b)=>a-b)
  assert.equal(angles.length,4)
  for(let i=0;i<angles.length;i++){
    const difference=(angles[(i+1)%angles.length]-angles[i]+2*Math.PI)%(2*Math.PI)
    assert.ok(difference>1,'the first four stars are spread across four distinct arms')
  }
})

test('underrepresented kinds place a recent representative near the core and get larger stars',()=>{
  const stars=Array.from({length:80},(_,i)=>({
    id:'knowledge:'+(i+1),
    time:new Date(Date.UTC(2026,0,1)-i*86_400_000).toISOString(),
    kind:i>=78?'fact':i>=76?'preference':'experience',
  } satisfies {id:string;time:string;kind:MemoryKind}))
  const orbits=knowledgeSpiral(stars)
  assert.deepEqual([...orbits.keys()].slice(0,3),['knowledge:1','knowledge:77','knowledge:79'])
  for(const id of ['knowledge:77','knowledge:79']){
    const orbit=orbits.get(id)!
    assert.ok(orbit.representative)
    assert.ok(radiusOf(orbit)>.24&&radiusOf(orbit)<.34,'the representative keeps some clearance from the core')
  }
  assert.ok(orbits.get('knowledge:80')!.sizeScale>1.1,'outer stars of rare kinds also get a size boost')
  assert.ok([...orbits.values()].every(orbit=>orbit.sizeScale<=1.5))
})

test('even a single batch spreads along stable, open spiral arms',()=>{
  const stars=Array.from({length:500},(_,i)=>({
    id:'knowledge:'+(i+1),time:'2026-01-01T00:00:00Z',kind:kinds[i%kinds.length],
  }))
  const orbits=knowledgeSpiral(stars)
  const reversed=knowledgeSpiral([...stars].reverse())
  const radii=new Set<number>()
  const points=[...orbits.values()]
  for(const [id,orbit] of orbits){
    radii.add(Math.round(radiusOf(orbit)*1000))
    assert.deepEqual(orbit.position(frame),reversed.get(id)!.position(frame))
  }
  assert.ok(radii.size>400,'same-date knowledge does not form a ring')
  const phases=[]
  for(let i=0;i<points.length;i+=25){
    const group=points.slice(i,i+25)
    // Multiplying by four folds the four arms into the same direction.
    const x=group.reduce((sum,{angle})=>sum+Math.cos(4*angle),0)
    const y=group.reduce((sum,{angle})=>sum+Math.sin(4*angle),0)
    const concentration=Math.hypot(x,y)/group.length
    // The arms sweep through more angle per radial step right next to the core.
    assert.ok(concentration>(i===0?.3:.45),'the wider arms stay distinct')
    phases.push(Math.atan2(y,x))
  }
  const winding=phases.slice(1).reduce((total,phase,i)=>{
    const step=phase-phases[i]
    return total+Math.atan2(Math.sin(step),Math.cos(step))/4
  },0)
  assert.ok(winding>Math.PI,'the arms sweep through more than half a turn')
})

test('large batches stay separated on a narrow screen',()=>{
  const latest=Date.UTC(2026,5,1,12),day=86_400_000
  const stars=Array.from({length:500},(_,i)=>({
    id:'knowledge:'+(i+1),
    time:new Date(latest-(i<375?0:7+3*(i-375))*day).toISOString(),
    kind:kinds[i%kinds.length],
  }))
  const positions=[...knowledgeSpiral(stars).values()].map(orbit=>orbit.position(frame))
  let tightPairs=0
  for(const [i,point] of positions.entries()){
    for(let j=i+1;j<positions.length;j++){
      const other=positions[j]
      if(Math.hypot((point.x-other.x)*3.9,(point.y-other.y)*3.8)<4)tightPairs++
    }
  }
  assert.ok(tightPairs<270,'few star centers fall within four pixels of each other')
})

test('latest knowledge starts at the core and older knowledge extends outward',()=>{
  const latest=Date.UTC(2026,0,1),day=86_400_000
  const ages=[0,1,7,30,365,3650,NaN]
  const starsAt=(anchor:number)=>ages.map((age,i)=>({
    id:'knowledge:'+(ages.length-i),time:Number.isFinite(age)?new Date(anchor-age*day).toISOString():'',
  }))
  const stars=starsAt(latest)
  const orbits=knowledgeSpiral(stars)
  const earlier=knowledgeSpiral(starsAt(latest-300*day))
  const sizes=stars.map(({id})=>orbits.get(id)!.sizeScale)
  assert.equal(sizes[0],1.5)
  assert.equal(sizes.at(-1),1)
  assert.ok(sizes.every((size,index)=>index===0||size<sizes[index-1]))
  const distances=stars.map(({id})=>{
    const orbit=orbits.get(id)!
    assert.deepEqual(orbit.position(frame),earlier.get(id)!.position(frame))
    return radiusOf(orbit)
  })
  assert.ok(Math.abs(distances[0]-.15)<1e-10)
  assert.ok(distances.every((distance,index)=>index===0||distance>distances[index-1]))
})
