import {useEffect,useLayoutEffect,useRef,useState,type FormEvent} from 'react'
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
import {useNativeCalendarStore,openNativeCalendar} from '../../stores/nativeCalendarStore'
import {nativeCalendarApi} from '../../api/nativeCalendar'

function localCalendarTime(date:Date){
 const pad=(n:number)=>String(n).padStart(2,'0')
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`
}

export default function DigitalCalendarEditor({date,event,projectId,onClose,onSaved}:{date:Date;event?:CalendarEvent;projectId:string;onClose:()=>void;onSaved:()=>void}){
 const {t}=useI18n(),compact=useCompactLayout(),panel=useRef<HTMLDivElement>(null),initialFocus=useRef<HTMLElement>(null)
 const [content,setContent]=useState(event?.content??'')
 const native=useNativeCalendarStore()
 const target=event?(event.target_id??'internal'):(native.syncEnabled?native.defaultTarget:'internal')
 useEffect(()=>{void useNativeCalendarStore.getState().refresh().catch(()=>{})},[])
 const [time,setTime]=useState(()=>event?localCalendarTime(new Date(event.starts_at)):localCalendarTime(date))
 const [end,setEnd]=useState(()=>localCalendarTime(new Date(new Date(event?.starts_at??date).getTime()+(event?.duration_minutes??30)*60000)))
 const changeStart=(value:string)=>{setTime(value);setEnd(value?localCalendarTime(new Date(new Date(value).getTime()+30*60000)):'')}
 const [reminder,setReminder]=useState(event?.reminder_minutes??0),[saving,setSaving]=useState(false),[error,setError]=useState(''),[discard,setDiscard]=useState(false)
 const request=useRef({id:crypto.randomUUID(),signature:''}),inFlight=useRef(false)
 const [initial]=useState(()=>({content:event?.content??'',time:event?localCalendarTime(new Date(event.starts_at)):localCalendarTime(date),reminder:event?.reminder_minutes??0,end:localCalendarTime(new Date(new Date(event?.starts_at??date).getTime()+(event?.duration_minutes??30)*60000))}))
 const dirty=content!==initial.content||time!==initial.time||end!==initial.end||reminder!==initial.reminder
 const close=()=>{if(inFlight.current)return;if(content.trim()&&dirty)setDiscard(true);else onClose()}
 useLayoutEffect(()=>{initialFocus.current=panel.current?.querySelector('textarea')??null},[])
 useOverlay(true,close,panel,compact,true,initialFocus)
 const duration=(new Date(end).getTime()-new Date(time).getTime())/60000
 const timeError=!time||!end||!Number.isFinite(duration)?t('digitalCalendar.invalidTime'):duration<=0?t('digitalCalendar.endAfterStart'):duration>10080?t('digitalCalendar.durationLimit'):''
 const valid=Boolean(content.trim()&&!timeError)
 const save=async(e?:FormEvent)=>{
  e?.preventDefault()
  if(!valid||inFlight.current)return
  if(!event&&native.syncEnabled&&target==='internal'){openNativeCalendar();return}
  inFlight.current=true;setSaving(true);setError('')
  const draft={content,starts_at:new Date(time).toISOString(),duration_minutes:duration,timezone_name:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',reminder_minutes:reminder}
  const signature=JSON.stringify({draft,target})
  if(request.current.signature&&request.current.signature!==signature)request.current.id=crypto.randomUUID()
  request.current.signature=signature
  try{
   if(target!=='internal'){
    native.observe(await nativeCalendarApi.submit({action:event?'update':'create',target_id:target,request_id:request.current.id,
     ...(event?{event_id:event.id,revision:event.revision,draft,duration_minutes:duration}:draft)}))
   }
   else if(event)await digitalCalendarApi.update(event.id,draft,event.revision)
   else await digitalCalendarApi.create(draft,request.current.id)
   onSaved();onClose()
  }catch(reason){setError(localizeErrorDisplay(reason instanceof Error?reason.message:String(reason)))}
  finally{inFlight.current=false;setSaving(false)}
 }
 return createPortal(<>
  <div className="digital-calendar-editor-backdrop" onClick={e=>{if(e.target===e.currentTarget&&!content.trim()&&!inFlight.current)onClose()}}>
   <ResizablePanel ref={panel} minWidth={320} minHeight={360} className="digital-calendar-editor" role="dialog" aria-modal="true" aria-label={t(event?'digitalCalendar.edit':'digitalCalendar.add')} tabIndex={-1} onClick={e=>e.stopPropagation()}>
    <header><h2>{t(event?'digitalCalendar.edit':'digitalCalendar.add')}</h2><Button variant="icon" disabled={saving} aria-label={t('common.close')} onClick={close}><Icon name="x"/></Button></header>
    <form onSubmit={save} onKeyDown={e=>{if(e.key==='Enter'&&!e.metaKey&&!e.ctrlKey&&(e.target as HTMLElement).closest('.date-time-picker'))e.preventDefault();if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void save()}}}>
     <div className="digital-calendar-editor-content">
      <label htmlFor="calendar-content">{t('digitalCalendar.content')}</label>
      <MarkdownEditor id="calendar-content" value={content} onChange={setContent} projectId={projectId} imagePrefix="calendar" ariaLabel={t('digitalCalendar.content')} placeholder={t('digitalCalendar.placeholder')} disabled={saving}/>
      <div className="digital-calendar-time-range">
       <div className="digital-calendar-field"><label>{t('digitalCalendar.startTime')}</label><div className="digital-calendar-time-control"><DateTimePicker value={time} onChange={changeStart} precision="minute" disabled={saving} ariaLabel={t('digitalCalendar.startTime')} popupClassName="digital-calendar-date-popup"/>{compact&&time&&<span className="digital-calendar-time-preview" aria-hidden="true"><span>{time.slice(0,10)}</span><span>{time.slice(11,16)}</span></span>}</div></div>
       <div className="digital-calendar-field"><label>{t('digitalCalendar.endTime')}</label><div className="digital-calendar-time-control"><DateTimePicker value={end} onChange={setEnd} precision="minute" disabled={saving} ariaLabel={t('digitalCalendar.endTime')} popupClassName="digital-calendar-date-popup"/>{compact&&end&&<span className="digital-calendar-time-preview" aria-hidden="true"><span>{end.slice(0,10)}</span><span>{end.slice(11,16)}</span></span>}</div></div>
      </div>
      <div className="digital-calendar-field"><label htmlFor="calendar-reminder">{t('digitalCalendar.reminder')}</label><select id="calendar-reminder" value={reminder} disabled={saving} onChange={e=>setReminder(Number(e.target.value))}>
       {[0,5,15,30,60,1440,...(![0,5,15,30,60,1440].includes(reminder)?[reminder]:[])].map(minutes=><option key={minutes} value={minutes}>{minutes?t('digitalCalendar.beforeMinutes',{count:minutes}):t('digitalCalendar.onTime')}</option>)}
      </select></div>
      <p className="digital-calendar-zone">{t('digitalCalendar.zone',{zone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})}</p>
      <div className="digital-calendar-editor-error" role={error||timeError?'alert':undefined}>{timeError||error}</div>
     </div>
     <footer><Button type="button" variant="ghost" disabled={saving} onClick={close}>{t('common.cancel')}</Button><Button variant="primary" type="submit" loading={saving} disabled={!valid}>{t(event?'digitalCalendar.saveChanges':'digitalCalendar.save')}</Button></footer>
    </form>
   </ResizablePanel>
  </div>
  <ConfirmDialog open={discard} title={t('digitalCalendar.discard')} message={t('digitalCalendar.discardMessage')} danger confirmText={t('digitalCalendar.discard')} onConfirm={onClose} onCancel={()=>setDiscard(false)}/>
 </>,document.body)
}
