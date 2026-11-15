import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {createCanvasLoop} from '../src/components/digital-person/avatar/canvasLoop'

test('render owner suspends hidden and offscreen, respects reduced motion and disconnects on disposal',async()=>{
 const {window}=installDomEnvironment(),saved={ResizeObserver:globalThis.ResizeObserver,IntersectionObserver:globalThis.IntersectionObserver,requestAnimationFrame:globalThis.requestAnimationFrame,cancelAnimationFrame:globalThis.cancelAnimationFrame}
 const frames=new Map<number,FrameRequestCallback>();let id=0,resizeDisconnected=false,intersectionDisconnected=false,intersect:(entries:any[])=>void=()=>{}
 const media=new window.EventTarget();Object.assign(media,{matches:false})
 window.matchMedia=(()=>media) as any
 Object.assign(globalThis,{
  requestAnimationFrame:(cb:FrameRequestCallback)=>{frames.set(++id,cb);return id},cancelAnimationFrame:(n:number)=>frames.delete(n),
  ResizeObserver:class{observe(){}disconnect(){resizeDisconnected=true}},
  IntersectionObserver:class{constructor(cb:(entries:any[])=>void){intersect=cb}observe(){}disconnect(){intersectionDisconnected=true}},
 })
 const draws:boolean[]=[],loop=createCanvasLoop(document.createElement('canvas'),(_now,_delta,reduced)=>{draws.push(reduced);return true})
 const tick=(now:number)=>{const pending=[...frames.values()];frames.clear();pending.forEach(cb=>cb(now))}
 try{
  tick(100);assert.equal(draws.length,1);assert.equal(frames.size,1)
  intersect([{isIntersecting:false}]);assert.equal(frames.size,0);loop.invalidate();assert.equal(frames.size,0)
  intersect([{isIntersecting:true}]);tick(1000);assert.equal(draws.length,2)
  Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new window.Event('visibilitychange'));assert.equal(frames.size,0)
  Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new window.Event('visibilitychange'))
  Object.assign(media,{matches:true});media.dispatchEvent(new window.Event('change'));tick(2000)
  assert.equal(draws.at(-1),true);assert.equal(frames.size,0)
  loop.dispose();loop.invalidate();assert.equal(frames.size,0);assert.ok(resizeDisconnected&&intersectionDisconnected)
 }finally{loop.dispose();Object.assign(globalThis,saved);await window.happyDOM.close()}
})
