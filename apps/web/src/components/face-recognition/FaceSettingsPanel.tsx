import { localizeErrorDisplay } from '../../i18n'
import {useCallback,useEffect,useRef,useState} from 'react'
import {faceApi,includesFaceContext,type FacePerson,type FaceSettings} from '../../api/faces'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import Spinner from '../Spinner'
import ConfirmDialog from '../ConfirmDialog'
import DigitalPersonCamera from '../digital-person/DigitalPersonCamera'
import FaceEnrollment from './FaceEnrollment'
import FacePersonEditor from './FacePersonEditor'
import {FACE_CHANGED} from './runtime'
import type {RecognizedFrame} from './useFaceRecognition'
import './FaceRecognition.css'

export default function FaceSettingsPanel({onDirtyChange,onBusyChange,showTitle=true}:{onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void;showTitle?:boolean}){
 const {t}=useI18n(),[people,setPeople]=useState<FacePerson[]>([]),[saved,setSaved]=useState<FaceSettings|null>(null),[draft,setDraft]=useState<FaceSettings|null>(null),[tab,setTab]=useState('people'),[query,setQuery]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0)
 const [editing,setEditing]=useState<FacePerson|null>(null),[enrollment,setEnrollment]=useState<FacePerson|'new'|null>(null),[childDirty,setChildDirty]=useState(false),[childBusy,setChildBusy]=useState(false),[pending,setPending]=useState<string|null>(null),[captureReady,setCaptureReady]=useState(false),[frameText,setFrameText]=useState('')
 const capture=useRef<(()=>Promise<RecognizedFrame>)|null>(null)
 const dirty=JSON.stringify(saved)!==JSON.stringify(draft),blocked=busy||childBusy
 const changed=useCallback((v:boolean)=>setChildDirty(v),[]),busyChanged=useCallback((v:boolean)=>setChildBusy(v),[])
 useEffect(()=>{onDirtyChange?.(dirty||childDirty);return()=>onDirtyChange?.(false)},[dirty,childDirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(blocked);return()=>onBusyChange?.(false)},[blocked,onBusyChange])
 useEffect(()=>{let live=true;setLoading(true);setError('');void Promise.all([faceApi.people(),faceApi.settings()]).then(([p,s])=>{if(live){setPeople(p.items);setSaved(s.settings);setDraft(s.settings)}}).catch(e=>{if(live)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[revision])
 const ready=useCallback((fn:(()=>Promise<RecognizedFrame>)|null)=>{capture.current=fn;setCaptureReady(Boolean(fn))},[])
 const refresh=()=>{setEditing(null);setEnrollment(null);setChildDirty(false);setRevision(v=>v+1)}
 const switchTab=(next:string)=>{if(blocked)return;if(dirty||childDirty)setPending(next);else{setTab(next);setEditing(null);setEnrollment(null)}}
 const saveSettings=async(value=draft)=>{if(!value||blocked)return;setBusy(true);setError('');try{const r=await faceApi.saveSettings(value);setSaved(r.settings);setDraft(r.settings);window.dispatchEvent(new Event(FACE_CHANGED))}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 const testFrame=async()=>{if(!capture.current||busy)return;setBusy(true);setError('');try{const frame=await capture.current();const ids=[...new Set(frame.faces.flatMap(f=>f.person?[f.person.id]:[]))];const r=await faceApi.context(ids,frame.faces.filter(f=>!f.person).length);setFrameText(r.text||t('faceRecognition.noContext'))}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 if(loading)return <div className="face-camera-status"><Spinner/>{t('common.loading')}</div>
 if(!saved||!draft)return <div className="face-panel"><p role="alert" className="face-error">{localizeErrorDisplay(error)}</p><Button onClick={()=>setRevision(v=>v+1)}>{t('common.retry')}</Button></div>
 const childProps={onDirtyChange:changed,onBusyChange:busyChanged,onSaved:refresh}
 return <section className="face-panel">
  {showTitle&&<div className="face-panel-header"><h2>{t('faceRecognition.title')}</h2></div>}
  <div className="face-panel-tab-row">
   <div className="face-panel-tabs" role="tablist" aria-label={t('faceRecognition.title')}>{(['people','settings','test'] as const).map(value=><Button key={value} role="tab" aria-selected={tab===value} disabled={blocked} onClick={()=>switchTab(value)}>{t(`faceRecognition.${value}`)}</Button>)}</div>
   <label className="face-check face-enable-setting">
    <span>{t('faceRecognition.enabled')}</span>
    <button type="button" className="settings-switch" role="switch" aria-label={t('faceRecognition.enabled')} title={t('faceRecognition.enabled')} aria-checked={saved.enabled} disabled={blocked||dirty||childDirty} onClick={()=>void saveSettings({...saved,enabled:!saved.enabled})}><span className="settings-switch-thumb"/></button>
   </label>
  </div>
  {tab==='people'&&(enrollment?<FaceEnrollment key={enrollment==='new'?'new':enrollment.id} person={enrollment==='new'?undefined:enrollment} {...childProps} onClose={()=>setEnrollment(null)}/>:editing?<FacePersonEditor key={editing.id} person={editing} {...childProps} onClose={()=>setEditing(null)} onSupplement={()=>{setEnrollment(editing);setEditing(null)}}/>:<>
   <div className="face-toolbar"><Input aria-label={t('faceRecognition.search')} placeholder={t('faceRecognition.search')} value={query} onChange={e=>setQuery(e.target.value)}/><Button variant="primary" onClick={()=>setEnrollment('new')}>{t('faceRecognition.add')}</Button></div>
   {people.length===0?<div className="face-empty"><p>{t('faceRecognition.empty')}</p></div>:<div className="face-people">{people.filter(p=>(p.name+p.relationship).includes(query)).map(p=><div className="face-person-row" key={p.id}><div><h3>{p.name}</h3><small>{p.relationship}</small></div><span className="face-badge">{t('faceRecognition.samples',{count:p.sample_count})} · {t(p.enabled?'faceRecognition.active':'faceRecognition.paused')}</span><div className="face-person-actions"><Button onClick={()=>setEnrollment(p)}>{t('faceRecognition.supplement')}</Button><Button onClick={()=>setEditing(p)}>{t('faceRecognition.manage')}</Button></div></div>)}</div>}
  </>)}
  {tab==='settings'&&<div className="face-settings-list">{([
   ['show_boxes','faceRecognition.showBoxes'],['show_names','faceRecognition.showNames'],
   ['show_relationship','faceRecognition.showRelationship'],
  ] as const).map(([key,label])=><label className="face-check" key={key}><input type="checkbox" disabled={busy} checked={draft[key]??(key!=='show_relationship')} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/>{t(label)}</label>)}
   <p>{t('faceRecognition.displayHelp')}</p>
   <label className="face-check"><input type="checkbox" disabled={busy} checked={includesFaceContext(draft)} onChange={e=>setDraft({...draft,include_people:e.target.checked,include_relationship:e.target.checked})}/>{t('faceRecognition.includePeople')}</label>
   <label className="face-field">{t('faceRecognition.preset')}<Select disabled={busy} value={draft.preset} onChange={e=>setDraft({...draft,preset:e.target.value as FaceSettings['preset']})}>{(['balanced','light','clear'] as const).map(value=><option key={value} value={value}>{t(`faceRecognition.${value}`)}</option>)}</Select></label>
   <label className="face-field">{t('faceRecognition.threshold')}<Input disabled={busy} type="number" min={.5} max={.95} step={.05} value={draft.threshold} onChange={e=>setDraft({...draft,threshold:e.target.valueAsNumber})}/></label>
   <div className="face-footer"><div className="face-button-pair"><Button disabled={busy||!dirty} onClick={()=>setDraft(saved)}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={!dirty||!Number.isFinite(draft.threshold)||draft.threshold<.5||draft.threshold>.95} onClick={()=>void saveSettings()}>{t('common.save')}</Button></div></div>
  </div>}
  {tab==='test'&&<><p>{t('faceRecognition.testHint')}</p><DigitalPersonCamera onCaptureReady={ready}/><div><Button loading={busy} disabled={!captureReady||!saved.enabled} onClick={()=>void testFrame()}>{t('faceRecognition.testFrame')}</Button></div>{frameText&&<div className="face-context">{frameText}</div>}</>}
  {error&&<p className="face-error" role="alert">{localizeErrorDisplay(error)}</p>}{!enrollment&&!editing&&<p>{t('faceRecognition.privacy')}</p>}
  <ConfirmDialog open={pending!==null} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} onCancel={()=>setPending(null)} onConfirm={()=>{setDraft(saved);setTab(pending!);setPending(null);setEditing(null);setEnrollment(null);setChildDirty(false)}}/>
 </section>
}
