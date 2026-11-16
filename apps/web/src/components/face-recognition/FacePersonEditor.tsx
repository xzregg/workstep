import {useEffect,useState} from 'react'
import {faceApi,type FacePerson,type FaceSample,type FaceEdit} from '../../api/faces'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import ConfirmDialog from '../ConfirmDialog'
import {FACE_CHANGED} from './runtime'
export default function FacePersonEditor({person,onClose,onSaved,onSupplement,onDirtyChange,onBusyChange}:{person:FacePerson;onClose:()=>void;onSaved:()=>void;onSupplement:()=>void;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}){
 const {t}=useI18n(),[draft,setDraft]=useState<FaceEdit>({name:person.name,relationship:person.relationship,notes:person.notes,enabled:Boolean(person.enabled)}),[samples,setSamples]=useState<FaceSample[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState<'delete'|'discard'|FaceSample|null>(null)
 const initial={name:person.name,relationship:person.relationship,notes:person.notes,enabled:Boolean(person.enabled)},dirty=JSON.stringify(initial)!==JSON.stringify(draft)
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false)},[dirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false)},[busy,onBusyChange])
 useEffect(()=>{let live=true;void faceApi.samples(person.id).then(r=>{if(live)setSamples(r.items)}).catch(e=>{if(live)setError(String(e))});return()=>{live=false}},[person.id])
 const run=async(fn:()=>Promise<unknown>,close=true)=>{if(busy)return;setBusy(true);setError('');try{await fn();window.dispatchEvent(new Event(FACE_CHANGED));if(close)onSaved();else{setSamples((await faceApi.samples(person.id)).items);setConfirm(null)}}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 return <section className="face-panel">
  <div className="face-panel-header"><h2>{t('faceRecognition.manage')} · {person.name}</h2><Button disabled={busy} onClick={()=>dirty?setConfirm('discard'):onClose()}>{t('common.close')}</Button></div>
  <div className="face-form"><label className="face-field">{t('faceRecognition.name')}<Input value={draft.name} maxLength={40} disabled={busy} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label className="face-field">{t('faceRecognition.relationship')}<Input value={draft.relationship} maxLength={80} disabled={busy} onChange={e=>setDraft({...draft,relationship:e.target.value})}/></label><label className="face-field">{t('faceRecognition.notes')}<textarea value={draft.notes} maxLength={400} disabled={busy} onChange={e=>setDraft({...draft,notes:e.target.value})}/></label><label className="face-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>{t('faceRecognition.allow')}</label></div>
  <div className="face-footer"><div className="face-button-pair"><Button disabled={busy||!dirty} onClick={()=>setDraft(initial)}>{t('faceRecognition.reset')}</Button><Button variant="primary" loading={busy} disabled={!dirty||!draft.name.trim()||!draft.relationship.trim()} onClick={()=>void run(()=>faceApi.update(person.id,draft))}>{t('common.save')}</Button></div></div>
  <div className="face-toolbar"><h3>{t('faceRecognition.samples',{count:samples.length})}</h3><Button disabled={dirty||busy} onClick={onSupplement}>{t('faceRecognition.supplement')}</Button></div>
  <div className="face-sample-list">{samples.map((s,i)=><div key={s.id}><span>{i+1}. <small>{new Date(s.created_at).toLocaleString()}</small></span><Button disabled={busy} onClick={()=>setConfirm(s)}>{t('faceRecognition.removeSample')}</Button></div>)}</div>
  <p role="alert" className="face-error">{error}</p><div><Button variant="danger" disabled={busy} onClick={()=>setConfirm('delete')}>{t('faceRecognition.remove')}</Button></div>
  <ConfirmDialog open={confirm!==null} title={t(confirm==='discard'?'faceRecognition.discardTitle':confirm==='delete'?'faceRecognition.deleteTitle':'faceRecognition.deleteSample')} message={t(confirm==='discard'?'faceRecognition.discardMessage':confirm==='delete'?'faceRecognition.deleteMessage':'faceRecognition.deleteSampleMessage')} loading={busy} confirmDisabled={busy} onCancel={()=>{if(!busy)setConfirm(null)}} onConfirm={()=>{if(confirm==='discard')onClose();else if(confirm==='delete')void run(()=>faceApi.delete(person.id));else if(confirm)void run(()=>faceApi.deleteSample(person.id,confirm.id),false)}}/>
 </section>
}
