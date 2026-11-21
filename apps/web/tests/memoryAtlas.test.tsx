import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import MemoryAtlas from '../src/components/digital-person/MemoryAtlas'
import {atlasToolEvent} from '../src/components/digital-person/atlasToolEvents'

test('atlas reads one marker page and fetches only the selected preview', async () => {
  const {window}=installDomEnvironment()
  Object.defineProperties(window.HTMLElement.prototype,{
    clientWidth:{configurable:true,get:()=>760},
    clientHeight:{configurable:true,get:()=>400},
  })
  const host=document.body.appendChild(document.createElement('div'))
  const root=createRoot(host)
  const originalFetch=globalThis.fetch
  const originalObserver=globalThis.ResizeObserver
  const originalRequestFrame=globalThis.requestAnimationFrame
  const originalCancelFrame=globalThis.cancelAnimationFrame
  let frameId=0
  const frames=new Map<number,FrameRequestCallback>()
  globalThis.requestAnimationFrame=callback=>{
    frames.set(++frameId,callback)
    return frameId
  }
  globalThis.cancelAnimationFrame=id=>{frames.delete(id)}
  const advanceFrame=(time:number)=>{
    const callbacks=[...frames]
    frames.clear()
    for(const [,callback] of callbacks)callback(time)
  }
  const requests:string[]=[]
  const pending:Array<{finish:(response:Response)=>void;signal:AbortSignal|null|undefined}>=[]
  globalThis.ResizeObserver=class {
    observe(){}
    unobserve(){}
    disconnect(){}
  }
  const kinds=['event','preference','experience','fact']
  const star=(id:number)=>({id:'knowledge:'+id,time:'2026-11-21',importance:.5,kind:kinds[id%kinds.length]})
  globalThis.fetch=async (input,options)=>{
    const path=String(input)
    requests.push(path)
    if(path.includes('ids=1'))return Response.json({items:[star(1)]})
    if(path.includes('ids=49'))return Response.json({
      items:[star(50),star(49),star(48)],links:[{from:'knowledge:49',to:'knowledge:50'}],
    })
    if(path.endsWith('?limit=500'))return Response.json({
      items:Array.from({length:500},(_,i)=>star(i+48)),next_cursor:48,
    })
    return new Promise(finish=>pending.push({finish,signal:options?.signal}))
  }
  const button=(id:number)=>host.querySelector<HTMLButtonElement>('.atlas-star[aria-label$=" · '+id+'"]')!
  try{
    await act(async()=>root.render(<I18nProvider><MemoryAtlas projectId="p" sessionId="s" voiceLevel={0}/></I18nProvider>))
    const atlas='/api/digital-person/memory/atlas'
    assert.deepEqual(requests,[atlas+'?limit=500'])
    assert.equal(host.querySelectorAll('.atlas-star').length,500)
    assert.deepEqual(new Set(Array.from(host.querySelectorAll<HTMLElement>('.atlas-star'),node=>node.dataset.orbit)),
      new Set(Array.from({length:500},(_,i)=>star(i+48).id)))
    assert.equal(host.querySelectorAll('.atlas-star[data-flare]').length,18)
    assert.equal(button(49).dataset.kind,'preference')
    assert.equal(button(50).dataset.kind,'experience')
    assert.notEqual(button(49).querySelector('i')!.style.width,button(50).querySelector('i')!.style.width)
    assert.notEqual(button(49).querySelector('i')!.style.opacity,button(50).querySelector('i')!.style.opacity)
    const camera=host.querySelector<HTMLElement>('.atlas-camera')!
    const sky=host.querySelector('.memory-atlas-sky')!
    const wheel=(deltaY:number)=>act(async()=>{
      sky.dispatchEvent(new window.WheelEvent('wheel',{deltaY,cancelable:true}))
    })
    let redraws=0
    for(let i=0;i<=60;i++){
      const previous=button(49).style.transform
      advanceFrame(i*1000/60)
      if(button(49).style.transform!==previous)redraws++
    }
    assert.equal(redraws,24,'a 60 Hz display averages 24 idle updates per second')
    const beforeZoom=button(49).style.transform
    await wheel(-120)
    await wheel(-120)
    assert.equal(button(49).style.transform,beforeZoom,'gesture events wait for the next animation frame')
    assert.equal(frames.size,1,'gestures share the scheduled animation frame')
    advanceFrame(1017)
    assert.notEqual(button(49).style.transform,beforeZoom)
    await act(async()=>camera.querySelectorAll('button')[2].click())
    advanceFrame(1034)
    assert.equal(camera.dataset.adjusted,'false')
    await wheel(-120)
    assert.equal(camera.dataset.adjusted,'true')
    await wheel(120)
    assert.equal(camera.dataset.adjusted,'false','returning to the default zoom clears the adjustment')
    await wheel(-120)
    await act(async()=>camera.querySelectorAll('button')[2].click())
    assert.equal(camera.dataset.adjusted,'false','reset clears the adjustment')
    const links=()=>[...host.querySelectorAll('.atlas-link-core[data-link]')]
    assert.equal(links().length,0,'no constellation before selection')

    await act(async()=>button(50).click())
    assert.equal(links().length,0,'relationships load with the selected preview')
    await act(async()=>button(49).click())
    assert.deepEqual(requests.slice(1),[atlas+'/50',atlas+'/49'])
    assert.equal(pending[0].signal?.aborted,true)

    await act(async()=>button(50).click())
    assert.equal(pending.length,3,'reselecting a cancelled star starts an independent request')
    await act(async()=>{
      pending[2].finish(Response.json({summary:'当前摘要',sources:[],links:[{from:'knowledge:49',to:'knowledge:50'}]}))
      pending[0].finish(Response.json({summary:'过期结果一',sources:[]}))
      pending[1].finish(Response.json({summary:'过期结果二',sources:[]}))
    })
    assert.equal(host.querySelector('.atlas-preview-summary')?.textContent,'当前摘要')
    assert.equal(links()[0]?.getAttribute('data-link'),'knowledge:49/knowledge:50')
    assert.equal(links()[0].getAttribute('data-highlighted'),'true')
    assert.equal(host.querySelectorAll('.atlas-star[data-linked]').length,2)
    assert.ok(links()[0].parentElement?.querySelector('.atlas-link-halo'))

    const scope={channel:'session_chat',project_id:'p',session_id:'s',messageId:'msg',toolCallId:'a'}
    await act(async()=>{
      for(const fields of [
        {type:'TOOL_CALL_START',name:'Bash'},
        {type:'TOOL_CALL_ARGS',args:{cmd:'workstep memory search --query test'}},
        {type:'TOOL_CALL_RESULT',output:'knowledge:1 | older memory'},
      ])window.dispatchEvent(new window.CustomEvent(atlasToolEvent,{detail:{...scope,...fields}}))
    })
    assert.equal(button(1).getAttribute('data-hit'),'true')
    assert.equal(requests.at(-1),atlas+'?limit=48&ids=1')
    assert.equal(links().length,1,'an unrelated recall hit does not create a link')
    await act(async()=>button(50).click())
    assert.equal(links().length,0,'deselecting clears the links even while recall is highlighted')

    const recall=async(toolCallId:string,output:string)=>act(async()=>{
      for(const fields of [
        {type:'TOOL_CALL_START',name:'Bash'},
        {type:'TOOL_CALL_ARGS',args:{cmd:'workstep memory search --query test'}},
        {type:'TOOL_CALL_RESULT',output},
      ])window.dispatchEvent(new window.CustomEvent(atlasToolEvent,{detail:{...scope,toolCallId,...fields}}))
    })
    await recall('b','knowledge:49 | related\nknowledge:50 | related\nknowledge:48 | unrelated')
    assert.equal(links().length,1)
    assert.equal(links()[0].getAttribute('data-link'),'knowledge:49/knowledge:50')
    assert.equal(links()[0].getAttribute('data-recall'),'true')
    assert.equal(button(49).hasAttribute('data-linked'),true)
    assert.equal(button(48).hasAttribute('data-linked'),false)
    assert.equal(button(48).getAttribute('data-hit'),'true')
    assert.equal(requests.at(-1),atlas+'?limit=48&ids=49&ids=50&ids=48','recall fetches only the hit relationships')

    await recall('c','memory:3 | source record')
    assert.equal(links().length,1,'a source-only result leaves the last knowledge constellation visible')

    await act(async()=>button(50).click())
    const preview=host.querySelector<HTMLElement>('.atlas-detail')!
    assert.equal(links()[0]?.hasAttribute('data-recall'),false,'manual selection shows its own links')
    await act(async()=>preview.click())
    assert.equal(host.querySelector('.atlas-detail'),preview)
    const outside=document.body.appendChild(document.createElement('button'))
    try{
      outside.focus()
      await act(async()=>outside.click())
      assert.equal(host.querySelector('.atlas-detail'),null)
      assert.equal(links()[0]?.getAttribute('data-recall'),'true','dismissal restores the latest recall')
      assert.equal(pending.at(-1)?.signal?.aborted,true)
      assert.equal(document.activeElement,outside,'dismissal preserves the outside target focus')
    }finally{outside.remove()}

    await recall('d','knowledge:48 | latest single match')
    assert.equal(links().length,0)
    assert.equal(host.querySelectorAll('.atlas-star[data-linked]').length,0)
    assert.equal(button(50).getAttribute('data-hit'),'false')
    assert.equal(button(48).getAttribute('data-hit'),'true')
  }finally{
    await act(async()=>root.unmount())
    globalThis.fetch=originalFetch
    globalThis.ResizeObserver=originalObserver
    globalThis.requestAnimationFrame=originalRequestFrame
    globalThis.cancelAnimationFrame=originalCancelFrame
    await window.happyDOM.close()
  }
})

test('atlas can open a legacy marker without a time field and read its preview on click', async () => {
  const {window}=installDomEnvironment()
  const host=document.body.appendChild(document.createElement('div'))
  const root=createRoot(host)
  const originalFetch=globalThis.fetch
  const originalObserver=globalThis.ResizeObserver
  globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}}
  const requests:string[]=[]
  globalThis.fetch=async input=>{
    const url=new URL(String(input),'http://localhost')
    requests.push(url.pathname+url.search)
    if(url.searchParams.get('limit')==='500')return Response.json({detail:'limit is out of range'},{status:422})
    const items=url.searchParams.has('cursor')
      ? [{id:'knowledge:49',summary:'已读取的旧知识',sources:[]}]
      : [{id:'knowledge:49',event_time:null,importance:.5,summary:'首屏旧数据',sources:[]}]
    return Response.json({items})
  }
  try{
    await act(async()=>root.render(<I18nProvider><MemoryAtlas projectId="p" sessionId="s" voiceLevel={0}/></I18nProvider>))
    const atlas='/api/digital-person/memory/atlas'
    assert.deepEqual(requests,[atlas+'?limit=500',atlas+'?limit=48'])
    assert.doesNotMatch(host.textContent??'',/首屏旧数据/)
    const star=host.querySelector<HTMLButtonElement>('.atlas-star')!
    await act(async()=>star.click())
    assert.deepEqual(requests,[atlas+'?limit=500',atlas+'?limit=48',atlas+'?cursor=50&limit=1'])
    assert.equal(host.querySelector('.atlas-preview-summary')?.textContent,'已读取的旧知识')
  }finally{
    await act(async()=>root.unmount())
    globalThis.fetch=originalFetch
    globalThis.ResizeObserver=originalObserver
    await window.happyDOM.close()
  }
})
