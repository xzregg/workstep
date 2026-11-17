import assert from 'node:assert/strict'
import test from 'node:test'
import { followConversationBottom, stopConversationFollow } from '../src/utils/smoothConversationFollow'

test('bottom follow coalesces updates, moves continuously and stops when settled or interrupted', () => {
  const original = { request:globalThis.requestAnimationFrame, cancel:globalThis.cancelAnimationFrame }
  const frames=new Map<number,FrameRequestCallback>();let id=0
  globalThis.requestAnimationFrame=cb=>{frames.set(++id,cb);return id}
  globalThis.cancelAnimationFrame=id=>{frames.delete(id)}
  const listeners=new Map<string,(event:never)=>void>()
  const container={addEventListener:(name:string,fn:(event:never)=>void)=>listeners.set(name,fn),removeEventListener:(name:string)=>listeners.delete(name),scrollTop:0,scrollHeight:500,clientHeight:200,ownerDocument:{hidden:false,getSelection:()=>null,defaultView:{matchMedia:()=>({matches:false})}}} as unknown as HTMLElement
  const following={current:true},programmatic={current:0}
  const tick=(time:number)=>{const batch=[...frames.values()];frames.clear();batch.forEach(cb=>cb(time))}
  try {
    followConversationBottom(container,programmatic,following)
    assert.equal(container.scrollTop,300,'initial history snaps directly to the bottom')
    Object.assign(container,{scrollHeight:700})
    followConversationBottom(container,programmatic,following)
    followConversationBottom(container,programmatic,following)
    assert.equal(frames.size,1,'resize and token events share a single frame')
    tick(16)
    assert.ok(container.scrollTop>300 && container.scrollTop<500)
    assert.equal(programmatic.current,container.scrollTop)
    for(let time=32;time<1500;time+=16)tick(time)
    assert.equal(container.scrollTop,500)
    assert.equal(frames.size,0,'settled conversations do not keep a frame loop')
    Object.assign(container,{scrollHeight:900})
    followConversationBottom(container,programmatic,following)
    following.current=false;const position=container.scrollTop;tick(1600)
    assert.equal(container.scrollTop,position,'browsing history stops follow immediately')
    assert.equal(frames.size,0)
    following.current=true
    followConversationBottom(container,programmatic,following)
    listeners.get('touchstart')!({touches:[{clientY:100}]} as never)
    listeners.get('touchmove')!({touches:[{clientY:150}]} as never)
    tick(1700)
    assert.equal(following.current,false,'touch scrolling toward history stops follow before another frame')
    assert.equal(container.scrollTop,position)
  } finally {
    stopConversationFollow(container)
    globalThis.requestAnimationFrame=original.request;globalThis.cancelAnimationFrame=original.cancel
  }
})
