import {FACE_MODEL_VERSION,type FaceCatalog} from '../../api/faces'
import {gatewayWorkspacePath} from '../../utils/gatewayWorkspacePath'
import type Human from '@vladmandic/human'
import {FaceOperationError,waitForRecognition} from './operation'
export interface FacePose {yaw:number;pitch:number;roll:number}
export interface FaceDetection {box:number[];embedding:number[];score:number;pose?:FacePose;faceBox?:number[]}
export interface FaceObservation extends FaceDetection {person:FaceCatalog['people'][number]|null;ambiguous?:boolean;enhanced?:boolean}
export const FACE_CHANGED='workstep-face-library-changed'
export const presets={balanced:{width:640,hz:10},light:{width:320,hz:15},clear:{width:960,hz:5}}
type Similarity=(a:number[],b:number[])=>number
let engine:Promise<Human>|null=null,queue:Promise<unknown>=Promise.resolve()
let stalled:Promise<unknown>|null=null
let compare:Similarity|undefined
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
  await human.load();compare=human.match.similarity;return human
 })().catch(e=>{engine=null;throw e})
 return engine
}
function identify(embedding:number[],catalog:FaceCatalog,similarity:Similarity){
 if(!embedding.length||!catalog.settings.enabled||catalog.model_version!==FACE_MODEL_VERSION)return {person:null}
 const ranked=catalog.people.map(person=>({person,score:Math.max(...person.embeddings.map(value=>similarity(embedding,value)))})).sort((a,b)=>b.score-a.score)
 const best=ranked[0]
 if(!best)return {person:null}
 if(best.score>=catalog.settings.threshold){
  if(ranked[1]&&!(best.score-ranked[1].score>=.05))return {person:null,ambiguous:true}
  return {person:best.person}
 }
 if(!(best.score>=.5)||best.person.embeddings.length<3)return {person:null}

 // A change in descriptor magnitude can depress Human's distance score.
 // Allow recovery only for the same leading candidate, with three enrolled
 // samples agreeing and a margin over every rival's strongest sample.
 const norm=Math.sqrt(embedding.reduce((sum,value)=>sum+value*value,0))
 if(!norm)return {person:null}
 const cosine=(sample:number[])=>{
  if(sample.length!==embedding.length)return -1
  let dot=0,squares=0
  for(let index=0;index<sample.length;index++){
   dot+=embedding[index]*sample[index]
   squares+=sample[index]*sample[index]
  }
  return squares?dot/(norm*Math.sqrt(squares)):-1
 }
 const thirdBestCosine=best.person.embeddings.map(cosine).sort((a,b)=>b-a)[2]
 if(!(thirdBestCosine>=Math.max(.65,catalog.settings.threshold)))return {person:null}
 const rival=ranked.slice(1).reduce((highest,{person})=>Math.max(highest,...person.embeddings.map(cosine)),-1)
 if(!(thirdBestCosine-rival>=.05))return {person:null,ambiguous:true}
 return {person:best.person}
}
export function matchFace(embedding:number[],catalog:FaceCatalog,similarity:Similarity){
 return identify(embedding,catalog,similarity).person
}
export function matchFrame(faces:FaceDetection[],catalog:FaceCatalog,similarity:Similarity):FaceObservation[]{
 return faces.map(face=>({...face,...identify(face.embedding,catalog,similarity)}))
}
export function faceBoxOverlap(a:number[],b:number[]){
 const width=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))
 const height=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]))
 const intersection=width*height
 return intersection/(a[2]*a[3]+b[2]*b[3]-intersection)
}

export async function retryFaceMatch(
 faces:FaceObservation[],
 detect:()=>Promise<FaceObservation[]>,
 brighten:()=>boolean,
){
 const [original]=faces
 if(faces.length>1||original?.person||original?.ambiguous||!brighten())return faces
 const retry=await detect()
 const [candidate]=retry
 if(retry.length!==1)return faces
 if(!original)return [{...candidate,enhanced:true}]
 if(!candidate.person||!(faceBoxOverlap(original.box,candidate.box)>=.4))return faces
 return [{...candidate,box:original.box,enhanced:true}]
}

function landmarkBounds(mesh:[number,number,number?][]){
 if(mesh.length<468)return undefined
 const xs=mesh.map(point=>point[0]),ys=mesh.map(point=>point[1])
 const left=Math.min(...xs),top=Math.min(...ys),width=Math.max(...xs)-left,height=Math.max(...ys)-top
 return [left,top,width,height].every(Number.isFinite)&&width>0&&height>0?[left,top,width,height]:undefined
}
const lowLightGamma=Uint8Array.from({length:256},(_,value)=>Math.round(255*(value/255)**.65))

function brightenLowLight(input:HTMLCanvasElement,box=[.15,.1,.7,.8]){
 const sample=document.createElement('canvas')
 sample.width=24;sample.height=24
 const context=sample.getContext('2d')
 if(!context)return false
 const [left,top,width,height]=box
 const x=Math.max(0,left),y=Math.max(0,top)
 const w=Math.min(1,left+width)-x,h=Math.min(1,top+height)-y
 if(w<=0||h<=0)return false
 context.drawImage(input,x*input.width,y*input.height,w*input.width,h*input.height,0,0,24,24)
 const pixels=context.getImageData(0,0,24,24).data
 let luminance=0
 for(let i=0;i<pixels.length;i+=4)luminance+=.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2]
 const mean=luminance/(pixels.length/4)
 if(mean<8||mean>=68)return false

 // Only modify the inference copy. The video, saved samples and sent photo
 // retain their original pixels.
 const target=input.getContext('2d')
 if(!target)return false
 const image=target.getImageData(0,0,input.width,input.height)
 for(let i=0;i<image.data.length;i+=4){
  image.data[i]=lowLightGamma[image.data[i]]
  image.data[i+1]=lowLightGamma[image.data[i+1]]
  image.data[i+2]=lowLightGamma[image.data[i+2]]
 }
 target.putImageData(image,0,0)
 return true
}
/** Copy before queueing: a later inference must never read a newer video frame. */
export function copyFrame(source:HTMLVideoElement|HTMLCanvasElement,width=1280){
 const w='videoWidth' in source?source.videoWidth:source.width,h='videoHeight' in source?source.videoHeight:source.height
 if(!w||!h)throw new Error('Camera is not ready')
 const canvas=document.createElement('canvas'),ratio=Math.min(1,width/Math.max(w,h))
 canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio)
 const context=canvas.getContext('2d');if(!context)throw new Error('Unable to read camera feed')
 context.drawImage(source,0,0,w,h,0,0,canvas.width,canvas.height)
 return canvas
}
export const faceRuntime={
 similarity(a:number[],b:number[]){return compare?.(a,b)??0},
 async detect(canvas:HTMLCanvasElement,catalog:FaceCatalog|null,width=640,poseOnly=false,preview=false):Promise<FaceObservation[]>{
  if(stalled)throw new FaceOperationError('timeout')
  const input=copyFrame(canvas,width)
  const run=queue.then(async()=>{
   const human=await load()
   const detect=async():Promise<FaceObservation[]>=>{
    const result=await human.detect(input,{face:{mesh:{enabled:poseOnly,keepInvalid:true},description:{enabled:!poseOnly}}})
    if(result.error)throw new Error(String(result.error))
    const faces:FaceDetection[]=result.face.map(f=>{
     const faceBox=poseOnly?landmarkBounds(f.meshRaw):undefined
     const angle=faceBox?f.rotation?.angle:undefined, degrees=180/Math.PI
     return {box:[f.box[0]/input.width,f.box[1]/input.height,f.box[2]/input.width,f.box[3]/input.height],embedding:Array.from(f.embedding||[]),score:f.boxScore,
      ...(faceBox&&{faceBox}),...(angle&&{pose:{yaw:angle.yaw*degrees,pitch:angle.pitch*degrees,roll:angle.roll*degrees}})}
    })
    return catalog?matchFrame(faces,catalog,human.match.similarity):faces.map(f=>({...f,person:null}))
   }
   const faces=await detect()
   if(!preview||poseOnly||!catalog?.settings.enabled||!catalog.people.length||catalog.model_version!==FACE_MODEL_VERSION)return faces
   return retryFaceMatch(faces,detect,()=>brightenLowLight(input,faces[0]?.box))
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
