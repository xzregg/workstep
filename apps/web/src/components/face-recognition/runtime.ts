import {FACE_MODEL_VERSION,type FaceCatalog} from '../../api/faces'
import {gatewayWorkspacePath} from '../../utils/gatewayWorkspacePath'
import type Human from '@vladmandic/human'
import {FaceOperationError,waitForRecognition} from './operation'
export interface FaceDetection {box:number[];embedding:number[];score:number}
export interface FaceObservation extends FaceDetection {person:FaceCatalog['people'][number]|null}
export const FACE_CHANGED='workstep-face-library-changed'
export const presets={balanced:{width:640,hz:10},light:{width:320,hz:15},clear:{width:960,hz:5}}
type Similarity=(a:number[],b:number[])=>number
let engine:Promise<Human>|null=null,queue:Promise<unknown>=Promise.resolve()
let stalled:Promise<unknown>|null=null
async function load(){
 if(!engine)engine=(async()=>{
  const {default:Human}=await import('@vladmandic/human')
  const human=new Human({backend:'webgl',debug:false,cacheModels:false,cacheSensitivity:0,
   modelBasePath:new URL(`${gatewayWorkspacePath()}/assets/face-models/human-3.3.6/`,location.origin).href,
   filter:{enabled:true,return:false,autoBrightness:false,flip:false},
   face:{enabled:true,detector:{maxDetected:8,minConfidence:.6,skipFrames:0,skipTime:0,rotation:false},
    mesh:{enabled:false},iris:{enabled:false},attention:{enabled:false},description:{enabled:true,skipFrames:0,skipTime:0},
    emotion:{enabled:false},antispoof:{enabled:false},liveness:{enabled:false}},
   body:{enabled:false},hand:{enabled:false},object:{enabled:false},gesture:{enabled:false},segmentation:{enabled:false}})
  // The actual canvas provides the first inference. Human's optional warmup
  // wraps GPU compilation in an unbounded promise on some WebViews.
  await human.load();return human
 })().catch(e=>{engine=null;throw e})
 return engine
}
export function matchFace(embedding:number[],catalog:FaceCatalog,similarity:Similarity){
 if(!embedding.length||!catalog.settings.enabled||catalog.model_version!==FACE_MODEL_VERSION)return null
 const ranked=catalog.people.map(person=>({person,score:Math.max(...person.embeddings.map(value=>similarity(embedding,value)))})).sort((a,b)=>b.score-a.score)
 const best=ranked[0]
 return best&&best.score>=catalog.settings.threshold&&(!ranked[1]||best.score-ranked[1].score>=.05)?best.person:null
}
export function matchFrame(faces:FaceDetection[],catalog:FaceCatalog,similarity:Similarity):FaceObservation[]{
 return faces.map(face=>({...face,person:matchFace(face.embedding,catalog,similarity)}))
}
/** Copy before queueing: a later inference must never read a newer video frame. */
export function copyFrame(source:HTMLVideoElement|HTMLCanvasElement,width=1280){
 const w='videoWidth' in source?source.videoWidth:source.width,h='videoHeight' in source?source.videoHeight:source.height
 if(!w||!h)throw new Error('摄像头尚未就绪')
 const canvas=document.createElement('canvas'),ratio=Math.min(1,width/Math.max(w,h))
 canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio)
 const context=canvas.getContext('2d');if(!context)throw new Error('无法读取摄像头画面')
 context.drawImage(source,0,0,w,h,0,0,canvas.width,canvas.height)
 return canvas
}
export const faceRuntime={
 async detect(canvas:HTMLCanvasElement,catalog:FaceCatalog|null,width=640):Promise<FaceObservation[]>{
  if(stalled)throw new FaceOperationError('timeout')
  const input=copyFrame(canvas,width)
  const run=queue.then(async()=>{
   const human=await load(),result=await human.detect(input)
   if(result.error)throw new Error(String(result.error))
   const faces:FaceDetection[]=result.face.map(f=>({box:[f.box[0]/input.width,f.box[1]/input.height,f.box[2]/input.width,f.box[3]/input.height],embedding:Array.from(f.embedding||[]),score:f.boxScore}))
   return catalog?matchFrame(faces,catalog,human.match.similarity):faces.map(f=>({...f,person:null}))
  })
  let settled=false
  const release=()=>{settled=true;if(stalled===run)stalled=null}
  run.then(release,release)
  queue=run.catch(()=>{})
  try{return await waitForRecognition(run)}catch(error){
   // TFJS shares a GPU backend: never start overlapping work after a timeout.
   if(!settled&&error instanceof FaceOperationError)stalled=run
   throw error
  }
 },
}
