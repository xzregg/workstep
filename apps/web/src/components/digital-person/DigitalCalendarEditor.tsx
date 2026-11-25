import {useLayoutEffect,useRef,useState,type FormEvent} from 'react'
import {createPortal} from 'react-dom'
import {digitalCalendarApi,type CalendarEvent} from '../../api/digitalCalendar'
import {localizeErrorDisplay,useI18n} from '../../i18n'
import {useOverlay} from '../../hooks/useOverlay'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import ResizablePanel from '../ResizablePanel'
import MarkdownEditor from '../MarkdownEditor'
import DateTimePicker from '../DateTimePicker'
import ConfirmDialog from '../ConfirmDialog'
import Button from '../Button'
import Icon from '../Icon'

function localCalendarTime(date:Date){
 const pad=(n:number)=>String(n).padStart(2,'0')
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`
}

export default function DigitalCalendarEditor({date,event,projectId,onClose,onSaved}:{date:Date;event?:CalendarEvent;projectId:string;onClose:()=>void;onSaved:()=>void}){
 const {t}=useI18n(),compact=useCompactLayout(),panel=useRef<HTMLDivElement>(null),initialFocus=useRef<HTMLElement>(null)
 const [content,setContent]=useState(event?.content??'')
 const [time,setTime]=useState(()=>event?localCalendarTime(new Date(event.starts_at)):localCalendarTime(date))
 const [reminder,setReminder]=useState(event?.reminder_minutes??0),[saving,setSaving]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false)
 const request=useRef({id:crypto.randomUUID(),signature:''}),inFlight=useRef(false)
 const [initial]=useState(()=>({content:event?.content??'',time:event?localCalendarTime(new Date(event.starts_at)):localCalendarTime(date),reminder:event?.reminder_minutes??0}))
 const dirty=content!==initial.content||time!==initial.time||reminder!==initial.reminder
 const close=()=>{if(inFlight.current)return;if(content.trim()&&dirty)setDiscard(true);else onClose()}
 useLayoutEffect(()=>{initialFocus.current=panel.current?.querySelector('textarea')??null},[])
 useOverlay(true,close,panel,compact,true,initialFocus)
 const valid=Boolean(content.trim()&&time&&Number.isFinite(new Date(time).getTime()))
 const save=async(e?:FormEvent)=>{
  e?.preventDefault()
  if(!valid||inFlight.current)return
  inFlight.current=true;setSaving(true);setError('')
  const draft={content,starts_at:new Date(time).toISOString(),timezone_name:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',reminder_minutes:reminder}
  const signature=JSON.stringify(draft)
  if(request.current.signature&&request.current.signature!==signature)request.current.id=crypto.randomUUID()
  request.current.signature=signature
  try{
   if(event)await digitalCalendarApi.update(event.id,draft,event.revision)
   else await digitalCalendarApi.create(draft,request.current.id)
   onSaved();onClose()
  }catch(reason){setError(localizeErrorDisplay(reason instanceof Error?reason.message:String(reason)))}
  finally{inFlight.current=false;setSaving(false)}
 }
 return createPortal(<>
  <div className="digital-calendar-editor-backdrop" onClick={e=>{if(e.target===e.currentTarget&&!content.trim()&&!inFlight.current)onClose()}}>
   <ResizablePanel ref={panel} minWidth={320} minHeight={360} className="digital-calendar-editor" role="dialog" aria-modal="true" aria-label={t(event?'digitalCalendar.edit':'digitalCalendar.add')} tabIndex={-1} onClick={e=>e.stopPropagation()}>
    <header><h2>{t(event?'digitalCalendar.edit':'digitalCalendar.add')}</h2><Button variant="icon" disabled={saving} aria-label={t('common.close')} onClick={close}><Icon name="x"/></Button></header>
    <form onSubmit={save} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void save()}}}>
     <div className="digital-calendar-editor-content">
      <label htmlFor="calendar-content">{t('digitalCalendar.content')}</label>
      <MarkdownEditor id="calendar-content" value={content} onChange={setContent} projectId={projectId} imagePrefix="calendar" ariaLabel={t('digitalCalendar.content')} placeholder={t('digitalCalendar.placeholder')} disabled={saving}/>
      <div className="digital-calendar-field"><label>{t('digitalCalendar.time')}</label><DateTimePicker value={time} onChange={setTime} precision="minute" disabled={saving} ariaLabel={t('digitalCalendar.time')} popupClassName="digital-calendar-date-popup"/></div>
      <div className="digital-calendar-field"><label htmlFor="calendar-reminder">{t('digitalCalendar.reminder')}</label><select id="calendar-reminder" value={reminder} disabled={saving} onChange={e=>setReminder(Number(e.target.value))}>
       {[0,5,15,30,60,1440,...(![0,5,15,30,60,1440].includes(reminder)?[reminder]:[])].map(minutes=><option key={minutes} value={minutes}>{minutes?t('digitalCalendar.beforeMinutes',{count:minutes}):t('digitalCalendar.onTime')}</option>)}
      </select></div>
      <p className="digital-calendar-zone">{t('digitalCalendar.zone',{zone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})}</p>
      <div className="digital-calendar-editor-error" role={error?'alert':undefined}>{error}</div>
     </div>
     <footer><Button type="button" variant="ghost" disabled={saving} onClick={close}>{t('common.cancel')}</Button><Button variant="primary" type="submit" loading={saving} disabled={!valid}>{t(event?'digitalCalendar.saveChanges':'digitalCalendar.save')}</Button></footer>
    </form>
   </ResizablePanel>
  </div>
  <ConfirmDialog open={discard} title={t('digitalCalendar.discard')} message={t('digitalCalendar.discardMessage')} danger confirmText={t('digitalCalendar.discard')} onConfirm={onClose} onCancel={()=>setDiscard(false)}/>
 </>,document.body)
}
