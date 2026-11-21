import assert from 'node:assert/strict'
import test from 'node:test'
import {galaxyFrame,initialGalaxyView,starOrbitPosition} from '../src/components/digital-person/memoryGalaxy'

test('500 knowledge stars spread across the disc and keep their positions for the same view',()=>{
  const frame=galaxyFrame(initialGalaxyView,0)
  const radii=new Set<number>()
  const heights=new Set<number>()
  const probe={...frame,project(x:number,z:number,height:number,belt:number){
    radii.add(Math.round(Math.hypot(x,z)*1000))
    heights.add(Math.round(height*1000))
    return frame.project(x,z,height,belt)
  }}
  for(let i=1;i<=500;i++){
    const id='knowledge:'+i
    assert.deepEqual(starOrbitPosition(id)(probe),starOrbitPosition(id)(frame))
  }
  assert.ok(radii.size>150,'stars use a range of radii instead of a few fixed rings')
  assert.ok(heights.size>30,'stars have different heights within the disc')
})
