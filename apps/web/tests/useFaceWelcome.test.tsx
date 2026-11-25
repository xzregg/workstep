import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act,StrictMode} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {faceApi} from '../src/api/faces'
import {useFaceWelcome} from '../src/components/digital-person/useFaceWelcome'

for(const departure of ['pagehide','hidden','manual','interrupted'] as const){
 test(`face welcome restores ${departure} downtime after a browser reload`,async context=>{
  const {window}=installDomEnvironment()
  let wall=60_000,monotonic=0,hidden=false
  context.mock.method(Date,'now',()=>wall)
  context.mock.method(performance,'now',()=>monotonic)
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden})
  const offers:unknown[]=[]
  context.mock.method(faceApi,'offerWelcome',async candidate=>{
   offers.push(candidate)
   return {text:'欢迎回来。',speak:false,personalized:false}
  })
  let welcome!:ReturnType<typeof useFaceWelcome>,root:Root
  function Harness(){
   welcome=useFaceWelcome({projectId:'home',sessionId:'main',active:true,blocked:false,speechBusy:false,muted:false,privateSpeechFallback:'欢迎回来。'})
   return <p role="status">{welcome.text}</p>
  }
  const mount=async()=>{
   root=createRoot(document.body.appendChild(document.createElement('div')))
   await act(async()=>root.render(<StrictMode><Harness/></StrictMode>))
  }
  const sample=async()=>act(async()=>welcome.observe({at:monotonic,ids:['known'],revision:1,awayMinutes:1}))
  try{
   await mount()
   for(monotonic=0;monotonic<=2000;monotonic+=500){wall=60_000+monotonic;await sample()}
   assert.equal(offers.length,0,'first recognition only establishes the baseline')
   wall=65_000
   if(departure==='pagehide')await act(async()=>window.dispatchEvent(new Event('pagehide')))
   if(departure==='hidden'){
    hidden=true
    await act(async()=>document.dispatchEvent(new Event('visibilitychange')))
    // A later pagehide must preserve the earlier departure time.
    wall=150_000
    await act(async()=>window.dispatchEvent(new Event('pagehide')))
   }
   if(departure==='manual')await act(async()=>{welcome.cameraClosed();welcome.observe(null)})
   await act(async()=>root.unmount())
   wall=180_000;monotonic=0;hidden=false
   await mount()
   if(departure==='manual')await act(async()=>welcome.cameraOpened())
   // Auto-restored camera startup sends resets before the first useful frame.
   await act(async()=>welcome.observe(null))
   for(monotonic=0;monotonic<=2500;monotonic+=500){wall=180_000+monotonic;await sample()}
   assert.equal(offers.length,1,'a stable familiar face welcomes after the persisted absence')
   assert.equal(document.querySelector('p[role="status"]')?.textContent,'欢迎回来。')
   for(monotonic=3000;monotonic<=5000;monotonic+=500){wall=180_000+monotonic;await sample()}
   assert.equal(offers.length,1,'the restored absence is consumed once')
  }finally{await act(async()=>root!.unmount());await window.happyDOM.close()}
 })
}

test('a short refresh excludes camera startup time and does not leak across workspaces',async context=>{
 const {window}=installDomEnvironment()
 let wall=60_000,monotonic=0,projectId='home'
 context.mock.method(Date,'now',()=>wall)
 context.mock.method(performance,'now',()=>monotonic)
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 const offers:unknown[]=[]
 context.mock.method(faceApi,'offerWelcome',async candidate=>{offers.push(candidate);return null})
 let welcome!:ReturnType<typeof useFaceWelcome>,root:Root
 function Harness(){
  welcome=useFaceWelcome({projectId,sessionId:'main',active:true,blocked:false,speechBusy:false,muted:false,privateSpeechFallback:''})
  return null
 }
 const mount=async()=>{
  root=createRoot(document.body.appendChild(document.createElement('div')))
  await act(async()=>root.render(<Harness/>))
 }
 const sample=()=>act(async()=>welcome.observe({at:monotonic,ids:['known'],revision:1,awayMinutes:1}))
 try{
  await mount();await sample()
  wall=65_000
  await act(async()=>window.dispatchEvent(new Event('pagehide')))
  await act(async()=>root.unmount())
  wall=80_000;await mount()
  // The page returns after 15 seconds, but camera initialization takes a minute.
  for(monotonic=0;monotonic<=2000;monotonic+=500){wall=140_000+monotonic;await sample()}
  assert.equal(offers.length,0)
  await act(async()=>root.unmount())
  wall=300_000;monotonic=0;projectId='other-home';await mount()
  for(monotonic=0;monotonic<=2000;monotonic+=500)await sample()
  assert.equal(offers.length,0,'another workspace starts without a return marker')
 }finally{await act(async()=>root!.unmount());await window.happyDOM.close()}
})

test('background return restores once and an ordinary stream reset cannot create a welcome',async context=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 let wall=60_000,monotonic=0,hidden=false
 context.mock.method(Date,'now',()=>wall)
 context.mock.method(performance,'now',()=>monotonic)
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden})
 const offers:unknown[]=[]
 context.mock.method(faceApi,'offerWelcome',async candidate=>{offers.push(candidate);return null})
 let welcome!:ReturnType<typeof useFaceWelcome>
 function Harness(){
  welcome=useFaceWelcome({projectId:'home',sessionId:'main',active:true,blocked:false,speechBusy:false,muted:false,privateSpeechFallback:''})
  return null
 }
 const frames=async(start:number)=>{
  for(let offset=0;offset<=2000;offset+=500){
   wall=start+offset;monotonic=wall-60_000
   await act(async()=>welcome.observe({at:monotonic,ids:['known'],revision:1,awayMinutes:1}))
  }
 }
 try{
  await act(async()=>root.render(<Harness/>));await frames(60_000)
  wall=65_000;hidden=true
  await act(async()=>document.dispatchEvent(new Event('visibilitychange')))
  wall=180_000;hidden=false
  await act(async()=>document.dispatchEvent(new Event('visibilitychange')))
  // BFCache restoration may emit both events; it must retain the return gap.
  const restored=new Event('pageshow')
  Object.defineProperty(restored,'persisted',{value:true})
  await act(async()=>window.dispatchEvent(restored))
  await act(async()=>welcome.observe(null))
  await frames(180_000)
  assert.equal(offers.length,1)
  await act(async()=>welcome.observe(null))
  await frames(300_000)
  assert.equal(offers.length,1,'camera interruption alone still rebuilds the baseline')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('unavailable browser storage preserves manual camera timing',async context=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 let wall=60_000,monotonic=0
 context.mock.method(Date,'now',()=>wall)
 context.mock.method(performance,'now',()=>monotonic)
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 context.mock.method(localStorage,'getItem',()=>{throw new Error('Storage denied')})
 context.mock.method(localStorage,'setItem',()=>{throw new Error('Storage denied')})
 const offers:unknown[]=[]
 context.mock.method(faceApi,'offerWelcome',async candidate=>{offers.push(candidate);return null})
 let welcome!:ReturnType<typeof useFaceWelcome>
 function Harness(){
  welcome=useFaceWelcome({projectId:'home',sessionId:'main',active:true,blocked:false,speechBusy:false,muted:false,privateSpeechFallback:''})
  return null
 }
 try{
  await act(async()=>root.render(<Harness/>))
  await act(async()=>welcome.cameraClosed())
  wall=180_000
  await act(async()=>welcome.cameraOpened())
  for(monotonic=0;monotonic<=2000;monotonic+=500){
   wall=180_000+monotonic
   await act(async()=>welcome.observe({at:monotonic,ids:['known'],revision:1,awayMinutes:1}))
  }
  assert.equal(offers.length,1)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
