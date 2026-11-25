import assert from 'node:assert/strict'
import test from 'node:test'
import {matchFace,matchFrame,retryFaceMatch} from '../src/components/face-recognition/runtime'
import {PreviewFaceTracking} from '../src/components/face-recognition/previewTracking'
import {FACE_MODEL_VERSION,type FaceCatalog} from '../src/api/faces'
import {FaceOperationError,waitForRecognition} from '../src/components/face-recognition/operation'
const similarity=(a:number[],b:number[])=>1-Math.abs(a[0]-b[0])
const catalog:FaceCatalog={revision:1,model_version:FACE_MODEL_VERSION,settings:{enabled:true,show_names:true,include_people:true,include_relationship:true,preset:'balanced',threshold:.65},people:[{id:'a',name:'甲',relationship:'朋友',embeddings:[[.1],[.02]]}]}
test('unknown or ambiguous people never acquire names',()=>{
 assert.equal(matchFace([1],catalog,similarity),null)
 assert.equal(matchFace([0],catalog,similarity)?.id,'a')
 const ambiguous={...catalog,people:[...catalog.people,{id:'b',name:'乙',relationship:'同事',embeddings:[[.01]]}]}
 assert.equal(matchFace([0],ambiguous,similarity),null)
 assert.equal(matchFace([0],{...catalog,settings:{...catalog.settings,enabled:false}},similarity),null)
 assert.equal(matchFace([0],{...catalog,model_version:'old'},similarity),null)
})
test('frame matching consumes only the selected screenshot detections',()=>{
 assert.deepEqual(matchFrame([],catalog,similarity),[])
 const result=matchFrame([{box:[0,0,.5,.5],embedding:[0],score:.9}],catalog,similarity)
 assert.equal(result[0].person?.id,'a')
 assert.equal(matchFrame([{box:[0,0,.5,.5],embedding:[1],score:.9}],catalog,similarity)[0].person,null)
})

test('FaceRes can recover a weak distance match using consistent normalized features',()=>{
 const person={...catalog.people[0],embeddings:[[1,0],[.98,.1],[.92,-.2]]}
 const enrolled={...catalog,people:[person]}
 const weak=()=>.54
 assert.equal(matchFace([1.6,0],enrolled,weak)?.id,'a')
 assert.equal(matchFace([0,0],enrolled,weak),null)
 assert.equal(matchFace([1.6,0],enrolled,()=>.49),null)
 assert.equal(matchFace([1.6,0],{...enrolled,people:[{...person,embeddings:[[1,0],[0,1],[0,-1]]}]},weak),null)
 assert.equal(matchFace([1.6,0],{...enrolled,people:[{...person,embeddings:[[1,0],[1,0]]}]},weak),null)
 const competitor={...person,id:'b',embeddings:[[1,.1]]}
 assert.equal(matchFace([1.6,0],{...enrolled,people:[person,competitor]},weak),null)
 const strict={...enrolled,settings:{...enrolled.settings,threshold:.95}}
 assert.equal(matchFace([1.2,1],strict,weak),null)
})

const observation=(value:number,box=[.2,.2,.4,.4])=>matchFrame([{box,embedding:[value],score:.9}],catalog,similarity)[0]
const frontal=observation(.25)

test('FaceRes retries only a low-light miss, keeping the original box and normal match rules',async()=>{
 const miss=observation(.48),aligned=observation(.39,[.21,.22,.39,.38])
 let calls=0
 const detect=async()=>{calls++;return [aligned]}
 assert.deepEqual(await retryFaceMatch([miss],detect,()=>false),[miss])
 assert.equal(calls,0)
 assert.deepEqual(await retryFaceMatch([miss],detect,()=>true),[{...aligned,box:miss.box,enhanced:true}])
 assert.equal(calls,1)
 assert.deepEqual(await retryFaceMatch([],detect,()=>false),[])
 assert.deepEqual(await retryFaceMatch([miss,miss],detect,()=>false),[miss,miss])
 assert.deepEqual(await retryFaceMatch([frontal],detect,()=>false),[frontal])
 const ambiguous={...miss,ambiguous:true}
 assert.deepEqual(await retryFaceMatch([ambiguous],detect,()=>false),[ambiguous])
 assert.equal(calls,1)
 assert.deepEqual(await retryFaceMatch([miss],async()=>[observation(.39,[.7,.7,.2,.2])],()=>true),[miss])
 assert.deepEqual(await retryFaceMatch([miss],async()=>[observation(.46)],()=>true),[miss])
 assert.deepEqual(await retryFaceMatch([miss],async()=>[{...aligned,person:null,ambiguous:true}],()=>true),[miss])
})

test('preview confirms frontal matches on two frames and bridges short misses in replay',()=>{
 const scenes=[
  {name:'正脸',frames:[frontal,frontal,frontal,frontal],baseline:4,stable:4},
  {name:'下半脸遮挡',frames:[observation(.48),observation(.51),frontal,frontal],baseline:2,stable:4},
  {name:'半闭眼',frames:[frontal,observation(.49),frontal,frontal],baseline:3,stable:4},
  {name:'侧偏或后仰',frames:[observation(.49,[.29,.23,.37,.35]),observation(.5,[.31,.23,.35,.34]),observation(.28,[.29,.2,.39,.4]),frontal],baseline:2,stable:4},
  {name:'暗光',frames:[observation(.54),frontal,observation(.52),frontal],baseline:2,stable:4},
 ]
 for(const {name,frames,baseline,stable} of scenes){
  const tracker=new PreviewFaceTracking(similarity)
  assert.equal(tracker.update([frontal],0,.65)[0].person,null)
  assert.equal(tracker.update([frontal],100,.65)[0].person?.id,'a')
  assert.equal(frames.filter(face=>face.person).length,baseline,name)
  assert.equal(frames.filter((face,i)=>tracker.update([face],200+i*200,.65)[0].person).length,stable,name)
 }
})

test('preview hold expires and rejects other people, missing faces and ambiguous tracks',()=>{
 const confirm=()=>{
  const tracker=new PreviewFaceTracking(similarity)
  tracker.update([frontal],0,.65)
  tracker.update([frontal],100,.65)
  return tracker
 }
 const tracker=confirm(),miss=observation(.49)
 assert.equal(tracker.update([miss],1000,.65)[0].person?.id,'a')
 assert.equal(tracker.visible(1600)[0].person,null)
 assert.equal(tracker.update([miss],1700,.65)[0].person,null)
 assert.equal(tracker.update([frontal],1800,.65)[0].person,null)
 assert.equal(tracker.update([frontal],2600,.65)[0].person,null)
 assert.equal(confirm().update([observation(.95)],200,.65)[0].person,null)
 assert.equal(confirm().update([{...miss,ambiguous:true}],200,.65)[0].person,null)
 assert.equal(confirm().update([{...miss,embedding:[]}],200,.65)[0].person,null)
 assert.equal(confirm().update([{...miss,person:{...catalog.people[0],id:'b'}}],200,.65)[0].person,null)
 assert.deepEqual(confirm().update([miss,miss],200,.65).map(face=>face.person),[null,null])
 const departed=confirm()
 assert.deepEqual(departed.update([],200,.65),[])
 assert.equal(departed.update([miss],300,.65)[0].person,null)
})

test('preview boxes expire when inference pauses, including unknown and late frames',()=>{
 const tracker=new PreviewFaceTracking(similarity)
 const unknown=observation(.95)
 tracker.update([unknown],100,.65)
 assert.equal(tracker.visible(1599).length,1)
 assert.equal(tracker.nextExpiry(100),1600)
 assert.deepEqual(tracker.visible(1600),[])
 tracker.update([frontal],2000,.65)
 tracker.update([frontal],2100,.65)
 assert.deepEqual(tracker.visible(3600),[])
 assert.equal(tracker.nextExpiry(3600),Infinity)
})

test('stalled recognition times out and late GPU completion cannot become a captured sample',async()=>{
 let finish!:(value:string)=>void
 const work=new Promise<string>(resolve=>{finish=resolve})
 await assert.rejects(waitForRecognition(work,undefined,10),error=>error instanceof FaceOperationError&&error.reason==='timeout')
 finish('late')
 assert.equal(await waitForRecognition(Promise.resolve('retry'),undefined,100),'retry')
 const controller=new AbortController();controller.abort()
 await assert.rejects(waitForRecognition(Promise.resolve('old'),controller.signal),error=>error instanceof FaceOperationError&&error.reason==='interrupted')
})
