import {useCallback,useId,useState} from 'react'
import {useI18n} from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import AssistantEngineSettings from '../AssistantEngineSettings'
import FaceSettingsPanel from './FaceSettingsPanel'
import FaceWelcomeSettings from './FaceWelcomeSettings'
import './FaceRecognition.css'

const tabs=['face','model','welcome'] as const
type Tab=typeof tabs[number]
const labels={face:'faceRecognition.title',model:'faceRecognition.modelTab',welcome:'faceWelcome.tab'} as const

export default function DigitalPersonVisionSettings({showFaceTitle=true,onDirtyChange,onBusyChange}:{showFaceTitle?:boolean;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}){
 const {t}=useI18n(),[tab,setTab]=useState<Tab>('face'),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<Tab|null>(null)
 const id=useId()
 const changed=useCallback((v:boolean)=>{setDirty(v);onDirtyChange?.(v)},[onDirtyChange]),blocked=useCallback((v:boolean)=>{setBusy(v);onBusyChange?.(v)},[onBusyChange])
 const select=(next:Tab)=>{if(next===tab||busy)return;if(dirty)setPending(next);else setTab(next)}
 return <div className="digital-person-vision">
  <nav className="face-vision-tabs" role="tablist" aria-label={t('digitalPerson.bodyeyes')}>{tabs.map((value,i)=><Button id={`${id}-${value}`} key={value} role="tab" aria-selected={tab===value} aria-controls={id} tabIndex={tab===value?0:-1} disabled={busy} onClick={()=>select(value)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1)!:tabs[(i+(e.key==='ArrowLeft'?tabs.length-1:1))%tabs.length];select(next);document.getElementById(`${id}-${next}`)?.focus()}}}>{t(labels[value])}</Button>)}</nav>
  <section id={id} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
   {tab==='face'?<FaceSettingsPanel showTitle={showFaceTitle} onDirtyChange={changed} onBusyChange={blocked}/>:tab==='welcome'?<FaceWelcomeSettings onDirtyChange={changed} onBusyChange={blocked}/>:<AssistantEngineSettings assistantName="digital_person" section="vision" onDirtyChange={changed} onBusyChange={blocked}/>}
  </section>
  <ConfirmDialog open={pending!==null} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} onCancel={()=>setPending(null)} onConfirm={()=>{setTab(pending!);setPending(null);changed(false)}}/>
 </div>
}
