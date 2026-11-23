import {useCallback,useEffect,useRef,useState,type RefObject} from 'react'
import {faceApi,includesFaceContext,FACE_MODEL_VERSION,type FaceCatalog} from '../../api/faces'
import {ApiError} from '../../api/transport'
import {useI18n} from '../../i18n'
import {copyFrame,FACE_CHANGED,faceRuntime,presets,type FaceObservation} from './runtime'
import {FaceOperationError} from './operation'
import {PreviewFaceTracking} from './previewTracking'
export interface RecognizedFrame {canvas:HTMLCanvasElement;faces:FaceObservation[];catalog:FaceCatalog|null;signal?:AbortSignal}
export interface FaceWelcomeFrame {
 at:number
 ids:(string|null)[]
 revision:number
 awayMinutes:number
}
export type FaceWelcomeObserver=(frame:FaceWelcomeFrame|null)=>void
const recentFaceWindowMs=1000
export function matchedPersonIds(faces:FaceObservation[]){
 return [...new Set(faces.flatMap(face=>face.person?[face.person.id]:[]))]
}
export function useFaceRecognition(active:boolean,video:RefObject<HTMLVideoElement|null>,enrollment=false,onWelcomeFrame?:FaceWelcomeObserver){
 const welcomeObserver=useRef(onWelcomeFrame);welcomeObserver.current=onWelcomeFrame
 const {t}=useI18n(),[faces,setFaces]=useState<FaceObservation[]>([]),[notice,setNotice]=useState('')
 const [loading,setLoading]=useState(false)
 const catalog=useRef<FaceCatalog|null>(null),token=useRef(0),loadingCatalog=useRef<Promise<void>|null>(null),catalogTime=useRef(0)
 const catalogGeneration=useRef(0)
 const latestMatch=useRef<{ids:string[];at:number;revision:number;stream:HTMLVideoElement['srcObject']}|null>(null)
 const recentMatch=useCallback((at:number)=>{
  const match=latestMatch.current
  return match&&match.stream&&match.stream===video.current?.srcObject&&match.at<=at&&at-match.at<=recentFaceWindowMs?match:null
 },[video])
 const refresh=useCallback(async()=>{
  if(loadingCatalog.current)return loadingCatalog.current
  const request=token.current,generation=catalogGeneration.current
  const current=()=>request===token.current&&generation===catalogGeneration.current
  const promise=faceApi.catalog().then(value=>{
   if(!current())return
   if(value.revision!==catalog.current?.revision){latestMatch.current=null;setFaces([])}
   catalog.current=value;catalogTime.current=Date.now()
  },error=>{if(current())throw error})
  loadingCatalog.current=promise
  try{await promise}finally{if(loadingCatalog.current===promise)loadingCatalog.current=null}
 },[])
 const analyze=useCallback(async(canvas:HTMLCanvasElement,force=false):Promise<RecognizedFrame>=>{
  if(enrollment)return {canvas,faces:await faceRuntime.detect(canvas,null,640,true),catalog:null}
  // Revalidate before sending or recording, rather than trusting a preview result.
  if(Date.now()-catalogTime.current>1000)await refresh()
  const value=catalog.current
  if(value&&value.model_version!==FACE_MODEL_VERSION)throw new Error(t('faceRecognition.incompatible'))
  if(!force&&(!value?.settings.enabled||!includesFaceContext(value.settings)))return {canvas,faces:[],catalog:value}
  const result=await faceRuntime.detect(canvas,value,presets[value?.settings.preset??'balanced'].width)
  return {canvas,faces:result,catalog:value}
 },[enrollment,refresh,t])
 useEffect(()=>{
  const request=++token.current;catalog.current=null;catalogTime.current=0;loadingCatalog.current=null;latestMatch.current=null
  setLoading(false)
  if(!active){setFaces([]);setNotice('');return}
  let timer:ReturnType<typeof setTimeout>,poll:ReturnType<typeof setTimeout>,expiry:ReturnType<typeof setTimeout>,closed=false
  let firstFrame=true
  let tracking=new PreviewFaceTracking(faceRuntime.similarity)
  let previewStream:HTMLVideoElement['srcObject']=null,previewRevision:number|undefined,mediaTime=-1
  const valid=()=>!closed&&request===token.current
  const reset=()=>{clearTimeout(expiry);tracking=new PreviewFaceTracking(faceRuntime.similarity);mediaTime=-1;latestMatch.current=null;setFaces([]);welcomeObserver.current?.(null)}
  const fail=(error:unknown)=>{if(!valid())return;reset();setLoading(false);setNotice(error instanceof ApiError&&[401,403,404].includes(error.status)?'':error instanceof FaceOperationError?error.message:t('faceRecognition.loadFailed'))}
  const publish=()=>{
   clearTimeout(expiry)
   if(!valid()||previewRevision!==catalog.current?.revision||previewStream!==video.current?.srcObject)return
   const now=performance.now(),next=tracking.nextExpiry(now)
   setFaces(tracking.visible(now))
   if(Number.isFinite(next))expiry=setTimeout(publish,Math.ceil(next-now))
  }
  const tick=async()=>{
   if(!valid())return
   const start=performance.now(),value=catalog.current,source=video.current,stream=source?.srcObject??null
   if(previewStream!==stream||previewRevision!==value?.revision){
    reset();previewStream=stream;previewRevision=value?.revision
   }
   try{
    if(source&&stream&&source.readyState>=2&&source.videoWidth&&source.currentTime!==mediaTime&&value?.settings.enabled){
     mediaTime=source.currentTime
     const currentTracking=tracking
     const frame=copyFrame(source,presets[value?.settings.preset??'balanced'].width)
     if(firstFrame)setLoading(true)
     const result=await faceRuntime.detect(frame,value,presets[value?.settings.preset??'balanced'].width,false,true)
     if(valid()&&firstFrame){firstFrame=false;setLoading(false)}
     if(valid()&&source===video.current&&stream===source.srcObject){
      if(currentTracking===tracking&&value.revision===catalog.current?.revision){
       const stable=tracking.update(result,start,value.settings.threshold)
       publish()
       if(value.welcome?.enabled&&value.model_version===FACE_MODEL_VERSION){
        const people=result.map((face,index)=>!face.enhanced&&!face.ambiguous&&face.person?.id===stable[index].person?.id?face.person?.id??null:null)
        welcomeObserver.current?.({at:start,ids:people,revision:value.revision,awayMinutes:value.welcome.away_minutes})
       }
       // The upload fallback still requires a fresh match on the original
       // preview pixels. Held labels and retry matches do not refresh it.
       const ids=matchedPersonIds(result.filter((face,index)=>!face.enhanced&&face.person?.id===stable[index].person?.id))
       if(includesFaceContext(value.settings)&&ids.length)latestMatch.current={ids,at:start,revision:value.revision,stream}
      }
      setNotice('')
     }
    }
   }catch(e){fail(e);return} // Reopen to retry; never spin on a broken GPU.
   if(valid())timer=setTimeout(()=>void tick(),Math.max(0,1000/presets[value?.settings.preset??'balanced'].hz-(performance.now()-start)))
  }
  const reload=async()=>{
   reset();catalog.current=null;catalogTime.current=0
   const generation=++catalogGeneration.current
   // Discard a catalog requested before the change, then reload serially.
   await loadingCatalog.current
   if(valid()&&generation===catalogGeneration.current)await refresh()
  }
  const check=async()=>{try{const r=await faceApi.revision();if(valid()&&r.revision!==catalog.current?.revision)await reload()}catch(e){if(valid()){catalog.current=null;fail(e)}}finally{if(valid())poll=setTimeout(()=>void check(),5000)}}
  const changed=()=>{void reload().catch(fail)}
  void refresh().then(()=>{if(valid()){void tick();poll=setTimeout(()=>void check(),5000)}}).catch(fail)
  window.addEventListener(FACE_CHANGED,changed)
  const clearCatalog=()=>{token.current++;catalog.current=null;latestMatch.current=null}
  return()=>{closed=true;clearCatalog();clearTimeout(timer);clearTimeout(poll);clearTimeout(expiry);window.removeEventListener(FACE_CHANGED,changed);welcomeObserver.current?.(null)}
 },[active,enrollment,refresh,t,video])
 return {faces,notice,loading:active&&loading,analyze,recentMatch,catalog:catalog.current}
}
