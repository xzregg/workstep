import type {DigitalPersonProfile} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import MarkdownEditor from '../MarkdownEditor'
import Button from '../Button'
import Input from '../Input'
import {defaultHeadings,documentSection,personaDocument,setDocumentSection,toggleDocumentItem,withPersonaDocument,type DocumentHeadings} from './digitalPersonMarkdown'
import './DigitalPersonDocuments.css'

export default function DigitalPersonDocuments({value,onChange,disabled=false,onChooseRole}:{value:DigitalPersonProfile;onChange:(profile:DigitalPersonProfile)=>void;disabled?:boolean;onChooseRole:()=>void}){
 const {t}=useI18n()
 const h:DocumentHeadings={...defaultHeadings,role:t('digitalPerson.identityLabel'),personality:t('digitalPerson.personality'),tone:t('digitalPerson.tone'),relationship:t('digitalPerson.documentRelationship'),greeting:t('digitalPerson.greeting'),duties:t('digitalPerson.documentDuties'),boundary:t('digitalPerson.documentBoundary'),memory:t('digitalPerson.documentMemory')}
 const persona=personaDocument(value,h,t(`digitalPerson.style${value.relationship_style??'balanced'}` as never))
 const duties=value.duties.replace('\n\n## 执行红线\n实际工作必须交给项目执行会话，绝不亲自执行。指派后立即返回，由后台跟进。','')
 const legacyDuties=`## ${h.duties}\n${duties.split('\n').filter(line=>line.trim()).map(line=>'- '+line).join('\n')}`
 const dutiesDocument=/^##\s/m.test(duties)||legacyDuties.length>8000?duties:legacyDuties
 const commit=(next:DigitalPersonProfile)=>onChange({...next,persona_markdown:next.persona_markdown??persona,duties:next.duties===value.duties?dutiesDocument:next.duties})
 const changePersona=(text:string)=>commit(withPersonaDocument(value,text,h))
 const selected=(key:keyof DocumentHeadings,item:string)=>documentSection(persona,key,h).some(line=>line===item||line.split(/[、，,；;]+/).includes(item))
 const tags=(label:string,items:{text:string;selected:boolean;click:()=>void}[])=> <div className="digital-person-document-tags" role="group" aria-label={label}><span>{label}</span>{items.map(item=><Button key={item.text} size="sm" disabled={disabled} aria-pressed={item.selected} onClick={item.click}>{item.text}</Button>)}</div>
 const roleItems=['assistant','rd','manager','study','creative','life'].map(key=>({key,text:t(`digitalPerson.rolePreset${key}` as never)}))
 const dutyPresets=[t('digitalPerson.dutyFollow'),t('digitalPerson.dutyClarify'),t('digitalPerson.dutySummarize')]
 const memoryPresets=[t('digitalPerson.memoryPrototype'),t('digitalPerson.memoryCosts'),t('digitalPerson.memoryUncertain')]
 return <div className="digital-person-documents">
  <label className="digital-person-document-name">{t('digitalPerson.name')}<Input name="name" maxLength={80} value={value.name} disabled={disabled} onChange={e=>commit({...value,name:e.target.value})}/></label>
  <section className="digital-person-document" data-document="persona"><h3>{t('digitalPerson.documentPersona')}</h3>
   {tags(h.role,roleItems.map(({key,text})=>({text,selected:selected('role',text),click:()=>{
    const next=withPersonaDocument(value,setDocumentSection(persona,'role',[text],h),h)
    // Only replace known preset duties; preserve the user's other sections and custom tasks.
    const bodies=documentSection(dutiesDocument,'duties',h),custom=bodies.filter(line=>![...dutyPresets,t('digitalPerson.dutyStudy')].includes(line))
    const defaults=key==='rd'?dutyPresets:key==='study'?[t('digitalPerson.dutyStudy')]:[t('digitalPerson.dutyFollow')]
    const duties=setDocumentSection(dutiesDocument,'duties',[...new Set([...defaults,...custom])].map(x=>'- '+x),h)
    commit({...next,duties})
   }})))}
   {tags(h.personality,['rigorous','curious','patient','proactive','rational','optimistic'].map(key=>{const text=t(`digitalPerson.personalityPreset${key}` as never);return {text,selected:selected('personality',text),click:()=>{
    const lines=documentSection(persona,'personality',h).flatMap(line=>line.split(/[、，,；;]+/)).map(x=>x.trim()).filter(Boolean)
    changePersona(setDocumentSection(persona,'personality',(lines.includes(text)?lines.filter(x=>x!==text):[...lines,text]).map(x=>'- '+x),h))
   }}}))}
   {tags(h.tone,['direct','warm','professional','humorous','supportive','detailed'].map(key=>{const text=t(`digitalPerson.tonePreset${key}` as never);return {text,selected:selected('tone',text),click:()=>changePersona(setDocumentSection(persona,'tone',[text],h))}}))}
   {tags(h.relationship,['balanced','warm','reserved','tsundere'].map(key=>{const text=t(`digitalPerson.style${key}` as never);return {text,selected:documentSection(persona,'relationship',h).includes(text),click:()=>{
    const known=['balanced','warm','reserved','tsundere'].map(k=>t(`digitalPerson.style${k}` as never))
    const custom=documentSection(persona,'relationship',h).filter(line=>!known.includes(line))
    commit({...withPersonaDocument(value,setDocumentSection(persona,'relationship',[text,...custom],h),h),relationship_style:key as DigitalPersonProfile['relationship_style']})
   }}}))}
   <Button variant="ghost" size="sm" disabled={disabled} onClick={onChooseRole}>{t('digitalPerson.chooseRole')}</Button>
   <MarkdownEditor value={persona} onChange={changePersona} ariaLabel={t('digitalPerson.documentPersona')} minHeight={200} maxHeight="65vh" maxLength={16000} allowAttachments={false} disabled={disabled}/>
  </section>
  <section className="digital-person-document" data-document="duties"><h3>{t('digitalPerson.duties')}</h3>
   {tags(t('digitalPerson.documentPresets'),dutyPresets.map((text,i)=>({text:[t('digitalPerson.dutyFollowLabel'),t('digitalPerson.dutyClarifyLabel'),t('digitalPerson.dutySummarizeLabel')][i],selected:documentSection(dutiesDocument,'duties',h).includes(text),click:()=>commit({...value,role_binding:null,duties:toggleDocumentItem(dutiesDocument,'duties',text,h)})})))}
   <MarkdownEditor value={dutiesDocument} onChange={duties=>commit({...value,duties,role_binding:null})} ariaLabel={t('digitalPerson.duties')} minHeight={160} maxHeight="65vh" maxLength={8000} allowAttachments={false} disabled={disabled}/>
  </section>
  <section className="digital-person-document" data-document="memory"><h3>{t('digitalPerson.memory')}</h3>
   {tags(t('digitalPerson.documentPresets'),memoryPresets.map((text,i)=>({text:[t('digitalPerson.memoryPrototypeLabel'),t('digitalPerson.memoryCostsLabel'),t('digitalPerson.memoryUncertainLabel')][i],selected:documentSection(value.conversation_rules??'','memory',h).includes(text),click:()=>commit({...value,conversation_rules:toggleDocumentItem(value.conversation_rules??'','memory',text,h)})})))}
   <MarkdownEditor value={value.conversation_rules??''} onChange={conversation_rules=>commit({...value,conversation_rules})} ariaLabel={t('digitalPerson.memory')} minHeight={140} maxHeight="65vh" maxLength={8000} allowAttachments={false} disabled={disabled}/>
  </section>
 </div>
}
