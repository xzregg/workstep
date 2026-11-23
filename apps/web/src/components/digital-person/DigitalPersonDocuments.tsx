import type {DigitalPersonProfile} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'
import MarkdownEditor from '../MarkdownEditor'
import Button from '../Button'
import Input from '../Input'
import {applyDocumentPresets,defaultHeadings,documentPresetItems,personaDocument,toggleDocumentItem,withPersonaDocument,type DocumentHeadings} from './digitalPersonMarkdown'
import './DigitalPersonDocuments.css'

export default function DigitalPersonDocuments({value,onChange,disabled=false,onChooseRole}:{value:DigitalPersonProfile;onChange:(profile:DigitalPersonProfile)=>void;disabled?:boolean;onChooseRole:()=>void}){
 const {t}=useI18n()
 const h:DocumentHeadings={...defaultHeadings,role:t('digitalPerson.identityLabel'),personality:t('digitalPerson.personality'),tone:t('digitalPerson.tone'),relationship:t('digitalPerson.documentRelationship'),greeting:t('digitalPerson.greeting'),duties:t('digitalPerson.documentDuties'),boundary:t('digitalPerson.documentBoundary'),memory:t('digitalPerson.documentMemory')}
 const persona=personaDocument(value,h,t(`digitalPerson.style${value.relationship_style??'balanced'}` as never))
 const dutiesDocument=value.duties.replace('\n\n## 执行红线\n实际工作必须交给项目执行会话，绝不亲自执行。指派后立即返回，由后台跟进。','')
 const commit=(next:DigitalPersonProfile)=>onChange({...next,persona_markdown:next.persona_markdown??persona})
 const changePersona=(text:string)=>commit(withPersonaDocument(value,text,h))
 const tags=(label:string,items:{text:string;selected:boolean;click:()=>void}[])=> <div className="digital-person-document-tags" role="group" aria-label={label}><span>{label}</span>{items.map(item=><Button key={item.text} size="sm" disabled={disabled} aria-pressed={item.selected} onClick={item.click}>{item.text}</Button>)}</div>
 const rolePresets=['assistant','rd','manager','study','creative','life'].map(key=>t(`digitalPerson.rolePreset${key}` as never))
 const personalityPresets=['rigorous','curious','patient','proactive','rational','optimistic'].map(key=>t(`digitalPerson.personalityPreset${key}` as never))
 const tonePresets=['direct','warm','professional','humorous','supportive','detailed'].map(key=>t(`digitalPerson.tonePreset${key}` as never))
 const relationshipPresets=(['balanced','warm','reserved','tsundere'] as const).map(key=>({key,text:t(`digitalPerson.style${key}` as never)}))
 const dutyPresets=[t('digitalPerson.dutyFollow'),t('digitalPerson.dutyClarify'),t('digitalPerson.dutySummarize')]
 const memoryPresets=[t('digitalPerson.memoryPrototype'),t('digitalPerson.memoryCosts'),t('digitalPerson.memoryUncertain')]
 const [selectedRole,selectedTraits,selectedTone,selectedRelationship]=documentPresetItems(persona,['role','personality','tone','relationship'],h)
 const [selectedDuties]=documentPresetItems(dutiesDocument,['duties'],h)
 const [selectedMemory]=documentPresetItems(value.conversation_rules??'',['memory'],h)
 return <div className="digital-person-documents">
  <label className="digital-person-document-name">{t('digitalPerson.name')}<Input name="name" maxLength={80} value={value.name} disabled={disabled} onChange={e=>commit({...value,name:e.target.value})}/></label>
  <section className="digital-person-document" data-document="persona"><h3>{t('digitalPerson.documentPersona')}</h3>
   {tags(h.role,rolePresets.map(text=>({text,selected:selectedRole.has(text),click:()=>changePersona(applyDocumentPresets(persona,'role',[text],rolePresets,h))})))}
   {tags(h.personality,personalityPresets.map(text=>({text,selected:selectedTraits.has(text),click:()=>changePersona(toggleDocumentItem(persona,'personality',text,h))})))}
   {tags(h.tone,tonePresets.map(text=>({text,selected:selectedTone.has(text),click:()=>changePersona(applyDocumentPresets(persona,'tone',[text],tonePresets,h))})))}
   {tags(h.relationship,relationshipPresets.map(({key,text})=>({text,selected:selectedRelationship.has(text),click:()=>{
    const next=applyDocumentPresets(persona,'relationship',[text],relationshipPresets.map(item=>item.text),h)
    commit({...withPersonaDocument(value,next,h),relationship_style:key})
   }})))}
   <Button variant="ghost" size="sm" disabled={disabled} onClick={onChooseRole}>{t('digitalPerson.chooseRole')}</Button>
   <MarkdownEditor value={persona} onChange={changePersona} ariaLabel={t('digitalPerson.documentPersona')} minHeight={200} maxHeight="65vh" maxLength={16000} allowAttachments={false} disabled={disabled}/>
  </section>
  <section className="digital-person-document" data-document="duties"><h3>{t('digitalPerson.duties')}</h3>
   {tags(t('digitalPerson.documentPresets'),dutyPresets.map((text,i)=>({text:[t('digitalPerson.dutyFollowLabel'),t('digitalPerson.dutyClarifyLabel'),t('digitalPerson.dutySummarizeLabel')][i],selected:selectedDuties.has(text),click:()=>commit({...value,role_binding:null,duties:toggleDocumentItem(dutiesDocument,'duties',text,h)})})))}
   <MarkdownEditor value={dutiesDocument} onChange={duties=>commit({...value,duties,role_binding:null})} ariaLabel={t('digitalPerson.duties')} minHeight={160} maxHeight="65vh" maxLength={8000} allowAttachments={false} disabled={disabled}/>
  </section>
  <section className="digital-person-document" data-document="memory"><h3>{t('digitalPerson.memory')}</h3>
   {tags(t('digitalPerson.documentPresets'),memoryPresets.map((text,i)=>({text:[t('digitalPerson.memoryPrototypeLabel'),t('digitalPerson.memoryCostsLabel'),t('digitalPerson.memoryUncertainLabel')][i],selected:selectedMemory.has(text),click:()=>commit({...value,conversation_rules:toggleDocumentItem(value.conversation_rules??'','memory',text,h)})})))}
   <MarkdownEditor value={value.conversation_rules??''} onChange={conversation_rules=>commit({...value,conversation_rules})} ariaLabel={t('digitalPerson.memory')} minHeight={140} maxHeight="65vh" maxLength={8000} allowAttachments={false} disabled={disabled}/>
  </section>
 </div>
}
