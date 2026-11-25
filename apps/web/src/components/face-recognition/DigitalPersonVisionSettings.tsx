import {useCallback,useId,useState} from 'react'
import {useI18n} from '../../i18n'
import SettingsTabs from '../SettingsTabs'
import ConfirmDialog from '../ConfirmDialog'
import FaceSettingsPanel from './FaceSettingsPanel'
import FaceWelcomeSettings from './FaceWelcomeSettings'
import './FaceRecognition.css'

const tabs=['face','welcome'] as const
type Tab=typeof tabs[number]
const labels={face:'faceRecognition.title',welcome:'faceWelcome.tab'} as const

export default function DigitalPersonVisionSettings({showFaceTitle=true,onDirtyChange,onBusyChange}:{showFaceTitle?:boolean;onDirtyChange?:(v:boolean)=>void;onBusyChange?:(v:boolean)=>void}){
 const {t}=useI18n(),[tab,setTab]=useState<Tab>('face'),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<Tab|null>(null)
 const id=useId()
 const changed=useCallback((v:boolean)=>{setDirty(v);onDirtyChange?.(v)},[onDirtyChange]),blocked=useCallback((v:boolean)=>{setBusy(v);onBusyChange?.(v)},[onBusyChange])
 const select=(next:Tab)=>{if(next===tab||busy)return;if(dirty)setPending(next);else setTab(next)}
 return <div className="digital-person-vision">
  <SettingsTabs tabs={tabs.map(value=>({id:value,label:t(labels[value])}))} selected={tab} onSelect={select} disabled={busy} panelId={id} label={t('digitalPerson.bodyeyes')} className="face-vision-tabs"/>
  <section id={id} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
   {tab==='face'?<FaceSettingsPanel showTitle={showFaceTitle} onDirtyChange={changed} onBusyChange={blocked}/>:<FaceWelcomeSettings onDirtyChange={changed} onBusyChange={blocked}/>}
  </section>
  <ConfirmDialog open={pending!==null} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} onCancel={()=>setPending(null)} onConfirm={()=>{setTab(pending!);setPending(null);changed(false)}}/>
 </div>
}
