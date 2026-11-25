import {useId,useState,type ReactNode} from 'react'
import {useI18n} from '../../i18n'
import AssistantEngineSettings from '../AssistantEngineSettings'
import ConfirmDialog from '../ConfirmDialog'
import SettingsTabs from '../SettingsTabs'

type Tab='settings'|'model'
export default function DigitalPersonProactiveSettings({children,actions,dirty,busy,onDiscard,onDirtyChange,onBusyChange}:{
 children:ReactNode;actions:ReactNode;dirty:boolean;busy:boolean;onDiscard:()=>void;onDirtyChange:(value:boolean)=>void;onBusyChange:(value:boolean)=>void
}){
 const {t}=useI18n(),id=useId(),[tab,setTab]=useState<Tab>('settings'),[pending,setPending]=useState<Tab|null>(null)
 const select=(next:Tab)=>{if(next===tab||busy)return;if(dirty)setPending(next);else setTab(next)}
 return <div className="digital-person-proactive-settings">
  <SettingsTabs tabs={[{id:'settings',label:t('digitalPerson.thinkingSettingsTab')},{id:'model',label:t('digitalPerson.modelSettingsTab')}]}
   selected={tab} onSelect={select} disabled={busy} panelId={id} label={t('digitalPerson.proactive')} className="digital-person-proactive-tabs"/>
  <section id={id} role="tabpanel" aria-labelledby={`${id}-${tab}`}>
   {tab==='settings'?<>{children}{actions}</>:<AssistantEngineSettings assistantName="digital_person_reflection" onDirtyChange={onDirtyChange} onBusyChange={onBusyChange}/>}
  </section>
  <ConfirmDialog open={pending!==null} title={t('digitalPerson.discard')} confirmDisabled={busy} onCancel={()=>setPending(null)} onConfirm={()=>{
   if(busy)return
   onDiscard();setTab(pending!);setPending(null)
  }}/>
 </div>
}
