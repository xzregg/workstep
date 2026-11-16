import {useCallback,useEffect,useRef,useState,type RefObject} from 'react'
import {faceApi,FACE_MODEL_VERSION,type FaceCatalog} from '../../api/faces'
import {ApiError} from '../../api/transport'
import {useI18n} from '../../i18n'
import {copyFrame,FACE_CHANGED,faceRuntime,presets,type FaceObservation} from './runtime'
import {FaceOperationError} from './operation'
export interface RecognizedFrame {canvas:HTMLCanvasElement;faces:FaceObservation[];catalog:FaceCatalog|null}
export function useFaceRecognition(active:boolean,video:RefObject<HTMLVideoElement|null>,enrollment=false){
 const {t}=useI18n(),[faces,setFaces]=useState<FaceObservation[]>([]),[notice,setNotice]=useState('')
 const catalog=useRef<FaceCatalog|null>(null),token=useRef(0),loadingCatalog=useRef<Promise<void>|null>(null),catalogTime=useRef(0)
 const refresh=useCallback(async()=>{
  if(loadingCatalog.current)return loadingCatalog.current
  const request=token.current
  const promise=(async()=>{const value=await faceApi.catalog();if(request===token.current){catalog.current=value;catalogTime.current=Date.now();setFaces([])}})()
  loadingCatalog.current=promise
  try{await promise}finally{if(loadingCatalog.current===promise)loadingCatalog.current=null}
 },[])
 const analyze=useCallback(async(canvas:HTMLCanvasElement,force=false):Promise<RecognizedFrame>=>{
  // Revalidate before sending or recording, rather than trusting a preview result.
  if(Date.now()-catalogTime.current>1000)await refresh()
  const value=catalog.current
  if(value&&value.model_version!==FACE_MODEL_VERSION)throw new Error(t('faceRecognition.incompatible'))
  if(!force&&!value?.settings.enabled)return {canvas,faces:[],catalog:value}
  const result=await faceRuntime.detect(canvas,value,presets[value?.settings.preset??'balanced'].width)
  return {canvas,faces:result,catalog:value}
 },[refresh,t])
 useEffect(()=>{
  const request=++token.current;catalog.current=null;catalogTime.current=0;loadingCatalog.current=null
  if(!active){setFaces([]);setNotice('');return}
  let timer:ReturnType<typeof setTimeout>,poll:ReturnType<typeof setTimeout>,closed=false
  const valid=()=>!closed&&request===token.current
  const fail=(error:unknown)=>{if(!valid())return;setFaces([]);setNotice(error instanceof ApiError&&[401,403,404].includes(error.status)?'':error instanceof FaceOperationError?error.message:t('faceRecognition.loadFailed'))}
  const tick=async()=>{
   if(!valid())return
   const start=performance.now(),value=catalog.current,source=video.current
   try{
    if(source?.readyState&&source.readyState>=2&&source.videoWidth&&(enrollment||value?.settings.enabled)){
     const frame=copyFrame(source,presets[value?.settings.preset??'balanced'].width)
     const result=await faceRuntime.detect(frame,value,presets[value?.settings.preset??'balanced'].width)
     if(valid()){if(value?.revision===catalog.current?.revision)setFaces(result);setNotice('')}
    }
   }catch(e){fail(e);return} // Reopen to retry; never spin on a broken GPU.
   if(valid())timer=setTimeout(()=>void tick(),Math.max(0,1000/presets[value?.settings.preset??'balanced'].hz-(performance.now()-start)))
  }
  const check=async()=>{try{const r=await faceApi.revision();if(valid()&&r.revision!==catalog.current?.revision)await refresh()}catch(e){catalog.current=null;fail(e)}finally{if(valid())poll=setTimeout(()=>void check(),5000)}}
  const changed=()=>{void refresh().catch(fail)}
  void refresh().then(()=>{if(valid()){void tick();poll=setTimeout(()=>void check(),5000)}}).catch(fail)
  window.addEventListener(FACE_CHANGED,changed)
  const clearCatalog=()=>{token.current++;catalog.current=null}
  return()=>{closed=true;clearCatalog();clearTimeout(timer);clearTimeout(poll);window.removeEventListener(FACE_CHANGED,changed)}
 },[active,enrollment,refresh,t,video])
 return {faces,notice,analyze,catalog:catalog.current}
}
