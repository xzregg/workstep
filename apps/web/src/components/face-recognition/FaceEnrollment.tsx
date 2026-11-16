import {useCallback,useEffect,useRef,useState} from 'react'
import {FACE_MODEL_VERSION,faceApi,type FacePerson} from '../../api/faces'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import ConfirmDialog from '../ConfirmDialog'
import DigitalPersonCamera from '../digital-person/DigitalPersonCamera'
import type {RecognizedFrame} from './useFaceRecognition'
import {FACE_CHANGED} from './runtime'
import './FaceRecognition.css'

export default function FaceEnrollment({person,onSaved,onClose,onDirtyChange,onBusyChange}:{person?:FacePerson;onSaved:()=>void;onClose:()=>void;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}){
 const {t}=useI18n(),[step,setStep]=useState(0),[name,setName]=useState(person?.name??''),[relationship,setRelationship]=useState(person?.relationship??''),[notes,setNotes]=useState(person?.notes??''),[consent,setConsent]=useState(false)
 const [samples,setSamples]=useState<number[][]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false),[cameraReady,setCameraReady]=useState(false)
 const capture=useRef<(()=>Promise<RecognizedFrame>)|null>(null),alive=useRef(true),busyRef=useRef(false)
 const dirty=Boolean(!person&&(name||relationship||notes)||consent||samples.length)
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false)},[dirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false)},[busy,onBusyChange])
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const ready=useCallback((fn:(()=>Promise<RecognizedFrame>)|null)=>{capture.current=fn;setCameraReady(Boolean(fn))},[])
 const angles=[t('faceRecognition.front'),t('faceRecognition.left'),t('faceRecognition.right')]
 const collect=async()=>{
  if(!capture.current||busyRef.current||samples.length>=3)return
  busyRef.current=true;setBusy(true);setError('')
  try{const result=await capture.current();if(!alive.current)return
   const face=result.faces[0]
   if(result.faces.length!==1||face.score<.6||face.embedding.length!==1024)throw new Error(t('faceRecognition.needOne'))
   setSamples(current=>[...current,face.embedding])
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}
  finally{busyRef.current=false;if(alive.current)setBusy(false)}
 }
 const save=async()=>{
  if(busyRef.current||samples.length!==3)return
  busyRef.current=true;setBusy(true);setError('')
  try{
   if(person)await faceApi.addSamples(person.id,samples)
   else await faceApi.create({name:name.trim(),relationship:relationship.trim(),notes,enabled:true,consent:true,embeddings:samples,model_version:FACE_MODEL_VERSION})
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
  {step===1&&<>
   <h3>{samples.length<3?`${samples.length+1} / 3 · ${angles[samples.length]}`:t('faceRecognition.captureDone')}</h3>
   <div className="face-samples-progress">{angles.map((label,i)=><div key={label} className={`face-sample-tile${samples[i]?' face-sample-tile--done':''}`} aria-current={samples.length===i?'step':undefined}><b>{i+1}</b><span>{label}</span><small>{t(samples[i]?'faceRecognition.done':samples.length===i?'faceRecognition.current':'faceRecognition.pending')}</small></div>)}</div>
   <DigitalPersonCamera enrollment onCaptureReady={ready}/>
   <div className="face-capture-controls"><p>{t('faceRecognition.captureGuide')}</p><Button disabled={!cameraReady||samples.length>=3} loading={busy} onClick={()=>void collect()}>{samples.length<3?t('faceRecognition.capture',{step:samples.length+1}):t('faceRecognition.captureDone')}</Button></div>
  </>}
  {step===2&&<><h3>{name} · {relationship}</h3><p>{t('faceRecognition.samples',{count:samples.length})}</p><p>{t('faceRecognition.review')}</p></>}
  <p className="face-error face-capture-note" role="alert">{error}</p>
  <div className="face-footer"><p>{t('faceRecognition.privacy')}</p><div className="face-button-pair">{step>0&&<Button disabled={busy} onClick={()=>{setError('');setStep(step-1)}}>{t('faceRecognition.previous')}</Button>}<Button variant="primary" loading={busy} disabled={step===0?!(name.trim()&&relationship.trim()&&consent):samples.length!==3} onClick={()=>{if(step===2)void save();else{setError('');setStep(step+1)}}}>{t(step===2?'faceRecognition.savePerson':'faceRecognition.next')}</Button></div></div>
  <ConfirmDialog open={discard} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} confirmText={t('faceRecognition.discard')} onCancel={()=>setDiscard(false)} onConfirm={onClose}/>
 </section>
}
