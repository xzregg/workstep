import test from 'node:test'
import assert from 'node:assert/strict'
import {createAtlasFrameBudget} from '../src/components/digital-person/useMemoryAtlasMotion'
import {galaxyFrame,galaxyPainter,initialGalaxyView} from '../src/components/digital-person/memoryGalaxy'

test('mobile atlas adapts to sustained draw cost instead of unrelated animation gaps',()=>{
 const budget=createAtlasFrameBudget()
 assert.equal(budget.resolution,1)
 assert.equal(budget.interval,1000/24)
 budget.record(803)
 budget.record(2)
 assert.equal(budget.resolution,1,'one startup stall must not degrade the scene')
 for(let i=0;i<5;i++)budget.record(20)
 assert.equal(budget.resolution,1)
 budget.record(20)
 assert.equal(budget.resolution,.75)
 assert.equal(budget.interval,1000/18)
 for(let i=0;i<6;i++)budget.record(18)
 assert.equal(budget.resolution,.5)
 assert.equal(budget.interval,1000/12)
 for(let i=0;i<20;i++)budget.record(30)
 assert.equal(budget.resolution,.5,'quality has a bounded floor')
})

function surface(){
 let fills=0
 const context={clearRect(){},fillRect(){fills++},drawImage(){},createRadialGradient(){return {addColorStop(){}}}}
 const document={createElement:()=>({width:0,height:0,getContext:()=>context})}
 const canvas={ownerDocument:document,width:0,height:0,dataset:{},getContext:()=>context}
 return {canvas:canvas as unknown as HTMLCanvasElement,reset:()=>{fills=0},fills:()=>fills}
}

test('mobile Canvas fallback bounds decorative dust work while retaining the full desktop scene',()=>{
 const originalWindow=globalThis.window
 Object.assign(globalThis,{window:{devicePixelRatio:3.25}})
 const mobile=surface(),desktop=surface()
 const gpu={hidden:true,getContext:()=>null} as unknown as HTMLCanvasElement
 try{
  const mobilePainter=galaxyPainter(mobile.canvas,gpu)
  assert.equal(mobilePainter.canBatchStars(),false)
  mobilePainter.paint(galaxyFrame(initialGalaxyView,0),388,230,[],1)
  const normal=mobile.fills()
  assert.ok(normal<4500,'Canvas fallback must not project and paint all 13,650 decorative particles')
  mobile.reset()
  mobilePainter.paint(galaxyFrame(initialGalaxyView,1),388,230,[],.5)
  assert.ok(mobile.fills()<normal,'sustained slow frames reduce CPU projection work as well as pixels')
  const desktopPainter=galaxyPainter(desktop.canvas,null)
  desktopPainter.paint(galaxyFrame(initialGalaxyView,0),760,400,[],1)
  assert.ok(desktop.fills()>10000,'desktop keeps the full particle field')
 }finally{Object.assign(globalThis,{window:originalWindow})}
})
