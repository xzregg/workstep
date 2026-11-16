import assert from 'node:assert/strict'
import test from 'node:test'
import {matchFace,matchFrame} from '../src/components/face-recognition/runtime'
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

test('stalled recognition times out and late GPU completion cannot become a captured sample',async()=>{
 let finish!:(value:string)=>void
 const work=new Promise<string>(resolve=>{finish=resolve})
 await assert.rejects(waitForRecognition(work,undefined,10),error=>error instanceof FaceOperationError&&error.reason==='timeout')
 finish('late')
 assert.equal(await waitForRecognition(Promise.resolve('retry'),undefined,100),'retry')
 const controller=new AbortController();controller.abort()
 await assert.rejects(waitForRecognition(Promise.resolve('old'),controller.signal),error=>error instanceof FaceOperationError&&error.reason==='interrupted')
})
