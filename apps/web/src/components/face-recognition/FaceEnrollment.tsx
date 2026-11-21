import { localizeErrorDisplay } from '../../i18n'
import {useCallback,useEffect,useRef,useState} from 'react'
import {FACE_MODEL_VERSION,faceApi,type FacePerson} from '../../api/faces'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import ConfirmDialog from '../ConfirmDialog'
import DigitalPersonCamera from '../digital-person/DigitalPersonCamera'
import type {RecognizedFrame} from './useFaceRecognition'
import {FACE_CHANGED,faceRuntime,type FaceDetection,type FaceObservation} from './runtime'
import {enrollmentHoldMs,enrollmentIssue,enrollmentMaxFrameGap,enrollmentPoses,enrollmentSampleInterval,sameEnrollmentPose} from './enrollmentQuality'
import './FaceRecognition.css'

type Capture=()=>Promise<RecognizedFrame>
type Sample={canvas:HTMLCanvasElement;embedding:number[]}
const noTracking={face:null,progress:null}

export default function FaceEnrollment({person,onSaved,onClose,onDirtyChange,onBusyChange}:{person?:FacePerson;onSaved:()=>void;onClose:()=>void;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}){
 const {t}=useI18n(),[step,setStep]=useState(0),[name,setName]=useState(person?.name??''),[relationship,setRelationship]=useState(person?.relationship??''),[notes,setNotes]=useState(person?.notes??''),[consent,setConsent]=useState(false)
 const [samples,setSamples]=useState<Sample[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false)
 const [capture,setCapture]=useState<Capture|null>(null),[index,setIndex]=useState(0),[retake,setRetake]=useState(false),[hint,setHint]=useState('')
 const [tracking,setTracking]=useState<{face:FaceObservation|null;progress:number|null}>(noTracking)
 const alive=useRef(true),busyRef=useRef(false),reviewTitle=useRef<HTMLHeadingElement>(null)
 const target=enrollmentPoses[index],sample=samples[index]
 const poseLabel=t(`faceEnrollment.${target}`)
 const dirty=Boolean(!person&&(name||relationship||notes)||consent||samples.length)
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false)},[dirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false)},[busy,onBusyChange])
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const ready=useCallback((fn:Capture|null)=>setCapture(()=>fn),[])
 const drawSample=useCallback((preview:HTMLCanvasElement|null)=>{
  if(!preview||!sample)return
  preview.width=sample.canvas.width;preview.height=sample.canvas.height
  preview.getContext('2d')?.drawImage(sample.canvas,0,0)
 },[sample])
 useEffect(()=>{if(step===2)reviewTitle.current?.focus({preventScroll:true})},[step])
 useEffect(()=>{
  if(step!==1||!capture||discard)return
  let cancelled=false,timer:ReturnType<typeof setTimeout>,stable:{face:FaceDetection;since:number;last:number;frames:number}|undefined
  let pendingIssue:ReturnType<typeof enrollmentIssue>=null
  const tick=async()=>{
   try{
    const frame=await capture()
    if(cancelled||frame.signal?.aborted)return
    const face=frame.faces.length===1&&frame.faces[0].faceBox?frame.faces[0]:null
    const issue=enrollmentIssue(frame,target)
    if(issue){
     if(issue!=='adjustPose'||pendingIssue===issue)stable=undefined
     if(!face||pendingIssue===issue){
      setTracking({face,progress:null})
      setHint(issue==='adjustPose'?t('faceEnrollment.adjustPose',{pose:poseLabel}):t(`faceEnrollment.${issue}`))
     }else setTracking(current=>({...current,face}))
     pendingIssue=issue
    }
    else{
     pendingIssue=null
     const now=performance.now(),validFace=frame.faces[0]
     if(!stable||now-stable.last>enrollmentMaxFrameGap||!sameEnrollmentPose(stable.face,validFace))stable={face:validFace,since:now,last:now,frames:1}
     else{stable.last=now;stable.frames++}
     const progress=Math.min(1,(now-stable.since)/enrollmentHoldMs,(stable.frames-1)/2)
     setTracking({face:validFace,progress})
     setHint(t('faceEnrollment.hold'))
     if(progress===1){
      const candidates=await faceRuntime.detect(frame.canvas,null,640)
      if(cancelled||frame.signal?.aborted)return
      const embedding=candidates.length===1?candidates[0].embedding:[]
      if(embedding.length===1024){
       setSamples(current=>{const next=[...current];next[index]={canvas:frame.canvas,embedding};return next})
       setTracking({face:validFace,progress:null})
       setHint('')
       if(retake||index===enrollmentPoses.length-1){setRetake(false);setStep(2)}else setIndex(index+1)
       return
      }
      stable=undefined;setTracking(noTracking);setHint(t('faceEnrollment.needOne'))
     }
    }
   }catch(reason){
    if(cancelled)return
    stable=undefined;setTracking(noTracking)
    const message=reason instanceof Error?reason.message:String(reason)
    if(message!==t('faceRecognition.notReady')){setHint(message);return}
   }
   if(!cancelled)timer=setTimeout(()=>void tick(),enrollmentSampleInterval)
  }
  setHint('')
  setTracking(current=>retake||index===0?noTracking:{...current,progress:null})
  timer=setTimeout(()=>void tick(),enrollmentSampleInterval)
  return()=>{cancelled=true;clearTimeout(timer)}
 },[capture,discard,index,poseLabel,retake,step,target,t])
 const save=async()=>{
  if(busyRef.current||samples.length!==enrollmentPoses.length)return
  busyRef.current=true;setBusy(true);setError('')
  try{
   const embeddings=samples.map(value=>value.embedding)
   if(person)await faceApi.addSamples(person.id,embeddings)
   else await faceApi.create({name:name.trim(),relationship:relationship.trim(),notes,enabled:true,consent:true,embeddings,model_version:FACE_MODEL_VERSION})
   window.dispatchEvent(new Event(FACE_CHANGED));if(alive.current)onSaved()
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}
  finally{busyRef.current=false;if(alive.current)setBusy(false)}
 }
 return <section className="face-panel" aria-label={t('faceRecognition.add')}>
  <div className="face-panel-header"><h2>{person?t('faceRecognition.supplement'):t('faceRecognition.add')}</h2><Button disabled={busy} onClick={()=>dirty?setDiscard(true):onClose()}>{t('common.cancel')}</Button></div>
  <div className="face-steps">{[t('faceRecognition.stepPerson'),t('faceRecognition.stepCapture'),t('faceRecognition.stepConfirm')].map((label,i)=><div key={i} className="face-step" aria-current={step===i?'step':undefined}><b>{i+1}</b>{label}</div>)}</div>
  {step===0&&<div className="face-form">
   <label className="face-field">{t('faceRecognition.name')}<Input autoFocus value={name} disabled={Boolean(person)||busy} maxLength={40} placeholder={t('faceRecognition.nameHint')} onChange={e=>setName(e.target.value)}/></label>
   <label className="face-field">{t('faceRecognition.relationship')}<Input value={relationship} disabled={Boolean(person)||busy} maxLength={80} placeholder={t('faceRecognition.relationshipHint')} onChange={e=>setRelationship(e.target.value)}/></label>
   <label className="face-field">{t('faceRecognition.notes')}<textarea value={notes} disabled={Boolean(person)||busy} maxLength={400} onChange={e=>setNotes(e.target.value)}/></label>
   <label className="face-check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>{t('faceRecognition.consent')}</label>
  </div>}
  {step>0&&<div className="face-enrollment-stage">
   <div className="face-enrollment-view">
    {step===1?<DigitalPersonCamera enrollment autoStart onCaptureReady={ready} enrollmentTracking={capture?tracking:noTracking}/>:<canvas ref={drawSample} role="img" aria-label={poseLabel}/>}
    <div className="face-enrollment-cue" role="status">{step===2?poseLabel:capture?(hint||poseLabel):t('faceEnrollment.openCamera')}
     {step===1&&capture&&tracking.progress!==null&&<span className="face-enrollment-progress" aria-hidden="true"><span style={{width:`${tracking.progress*100}%`}}/></span>}
    </div>
   </div>
   <div className="face-enrollment-side">
    {step===1?<><h3>{t('faceEnrollment.action')}</h3><div className="face-enrollment-pose">{poseLabel}</div><p>{t('faceEnrollment.auto')}</p></>:<>
     <h3 ref={reviewTitle} tabIndex={-1}>{t('faceEnrollment.preview')}</h3>
     <div className="face-enrollment-nav">
      <Button disabled={busy} onClick={()=>setIndex(value=>(value+enrollmentPoses.length-1)%enrollmentPoses.length)}>{t('faceEnrollment.prev')}</Button>
      <strong className="face-enrollment-index" role="status">{index+1} / {enrollmentPoses.length}</strong>
      <Button disabled={busy} onClick={()=>setIndex(value=>(value+1)%enrollmentPoses.length)}>{t('faceEnrollment.next')}</Button>
     </div>
     <p>{t('faceEnrollment.review')}</p>
    </>}
   </div>
  </div>}
  <p className="face-error face-capture-note" role="alert">{localizeErrorDisplay(error)}</p>
  <div className="face-footer"><p>{t('faceEnrollment.privacy')}</p><div className="face-button-pair">
   {step===0&&<Button variant="primary" disabled={!(name.trim()&&relationship.trim()&&consent)} onClick={()=>{setError('');setStep(1)}}>{t('faceRecognition.next')}</Button>}
   {step===1&&<Button onClick={()=>{setHint('');setRetake(false);setStep(retake?2:0)}}>{t(retake?'faceEnrollment.cancelRetake':'faceRecognition.previous')}</Button>}
   {step===2&&<><Button disabled={busy} onClick={()=>{setError('');setHint('');setRetake(true);setStep(1)}}>{t('faceEnrollment.retake')}</Button><Button variant="primary" loading={busy} disabled={samples.length!==enrollmentPoses.length} onClick={()=>void save()}>{t('faceRecognition.savePerson')}</Button></>}
  </div></div>
  <ConfirmDialog open={discard} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} confirmText={t('faceRecognition.discard')} onCancel={()=>setDiscard(false)} onConfirm={onClose}/>
 </section>
}
