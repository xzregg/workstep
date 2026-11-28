import {request} from './transport'

export const CALENDAR_CHANGED='workstep:digital-calendar-changed'
export interface CalendarDraft {content:string;starts_at:string;timezone_name:string;reminder_minutes:number;duration_minutes?:number}
export interface CalendarEvent extends CalendarDraft {
 id:string;revision:string;created_at:string;updated_at:string;reminder_at:string
 reminder_status:'pending'|'retry'|'notified'|'system';deleted_at?:string
 target_id?:string;plan_id?:string;duration_minutes?:number
 system_readonly?:boolean;system_calendar_name?:string;all_day?:boolean
}
export const digitalCalendarApi={
 list:(since:string,before:string,offset=0,signal?:AbortSignal)=>request<{items:CalendarEvent[];has_more:boolean;now:string}>(
  '/digital-person/calendar?'+new URLSearchParams({since,before,offset:String(offset),limit:'200'}),{signal}),
 create:(draft:CalendarDraft,requestId:string)=>request<CalendarEvent>('/digital-person/calendar',{method:'POST',body:JSON.stringify({...draft,request_id:requestId})}),
 update:(id:string,draft:CalendarDraft,revision:string)=>request<CalendarEvent>('/digital-person/calendar/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({...draft,revision})}),
 remove:(event:CalendarEvent)=>request<CalendarEvent>('/digital-person/calendar/'+encodeURIComponent(event.id)+'?'+new URLSearchParams({revision:event.revision}),{method:'DELETE'}),
 restore:(event:CalendarEvent)=>request<CalendarEvent>('/digital-person/calendar/'+encodeURIComponent(event.id)+'/restore',{method:'POST',body:JSON.stringify({revision:event.revision})}),
}
