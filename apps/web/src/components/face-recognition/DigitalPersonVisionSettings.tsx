import {useCallback,useState} from 'react'
import {useI18n} from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import AssistantEngineSettings from '../AssistantEngineSettings'
import FaceSettingsPanel from './FaceSettingsPanel'
import './FaceRecognition.css'

export default function DigitalPersonVisionSettings({onDirtyChange,onBusyChange}:{onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}){
 const {t}=useI18n(),[tab,setTab]=useState<'face'|'model'>('face'),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<'face'|'model'|null>(null)
 const changed=useCallback((v:boolean)=>{setDirty(v);onDirtyChange?.(v)},[onDirtyChange]),blocked=useCallback((v:boolean)=>{setBusy(v);onBusyChange?.(v)},[onBusyChange])
 const select=(next:'face'|'model')=>{if(next===tab||busy)return;if(dirty)setPending(next);else setTab(next)}
 return <div className="digital-person-vision">
  <nav className="face-vision-tabs" role="tablist" aria-label={t('digitalPerson.bodyeyes')}>{(['face','model'] as const).map((value,i)=><Button id={`vision-tab-${value}`} key={value} role="tab" aria-selected={tab===value} aria-controls="vision-settings-panel" tabIndex={tab===value?0:-1} disabled={busy} onClick={()=>select(value)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'face':e.key==='End'?'model':i===0?'model':'face';select(next);document.getElementById(`vision-tab-${next}`)?.focus()}}}>{t(value==='face'?'faceRecognition.title':'faceRecognition.modelTab')}</Button>)}</nav>
  <section id="vision-settings-panel" role="tabpanel" aria-labelledby={`vision-tab-${tab}`}>
   {tab==='face'?<FaceSettingsPanel onDirtyChange={changed} onBusyChange={blocked}/>:<AssistantEngineSettings assistantName="digital_person" section="vision" onDirtyChange={changed} onBusyChange={blocked}/>}
  </section>
  <ConfirmDialog open={pending!==null} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} onCancel={()=>setPending(null)} onConfirm={()=>{setTab(pending!);setPending(null);changed(false)}}/>
 </div>
}
