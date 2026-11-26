import {request} from './transport'
import type {CalendarDraft} from './digitalCalendar'
export interface CalendarTarget {id:string;name:string;device_id:string;device_name?:string;permission:string;online:boolean;available?:boolean}
export interface CalendarItem {id:string;event_id:string;status:string;draft:CalendarDraft;duration_minutes:number;revision?:string;system_id?:string;system_revision?:string;error_code?:string}
export interface CalendarOperation {id:string;plan_id:string;action:string;target_id:string;calendar_id?:string;device_id:string;status:string;items:CalendarItem[];token?:string;cancel_requested:boolean}
export interface CalendarIdentity {device_id:string;key:string;name:string;platform:string}
export interface CalendarHostStatus {permission:string;calendars:{id:string;name:string}[]}
export interface SystemCalendarEvent {system_id:string;calendar_name:string;content:string;starts_at:string;timezone_name:string;all_day:boolean;workstep_owned:boolean;content_truncated?:boolean}
export interface SystemCalendarPage {items:SystemCalendarEvent[];has_more:boolean}
export interface CalendarReceipt {item_id:string;status:'succeeded'|'failed'|'unknown';verification?:string;system_id?:string;system_revision?:string;error_code?:string}
export interface CalendarProgress {id:string;status:string;cancel_requested:boolean;item:Pick<CalendarItem,'id'|'status'|'error_code'>}
const base='/digital-person/calendar'
const json=(body:unknown)=>({method:'POST',body:JSON.stringify(body)})
const device=(identity:CalendarIdentity)=>base+'/devices/'+encodeURIComponent(identity.device_id)
const headers=(identity:CalendarIdentity)=>({'X-Calendar-Key':identity.key})
export const nativeCalendarApi={
 targets:()=>request<{owner:string;items:CalendarTarget[]}>(base+'/targets'),
 register:(identity:CalendarIdentity,status:CalendarHostStatus)=>request<{owner:string;targets:CalendarTarget[]}>(base+'/devices',json({...identity,...status})),
 submit:(body:Record<string,unknown>)=>request<CalendarOperation>(base+'/operations',json(body)),
 operation:(id:string)=>request<CalendarOperation>(base+'/operations/'+encodeURIComponent(id)),
 cancel:(id:string)=>request<CalendarOperation>(base+'/operations/'+encodeURIComponent(id)+'/cancel',json({})),
 resume:(id:string)=>request<CalendarOperation>(base+'/operations/'+encodeURIComponent(id)+'/resume',json({})),
 pending:(identity:CalendarIdentity)=>request<{items:Pick<CalendarOperation,'id'|'status'>[]}>(device(identity)+'/pending',{headers:headers(identity)}),
 claim:(identity:CalendarIdentity,id:string)=>request<CalendarOperation>(device(identity)+'/operations/'+encodeURIComponent(id)+'/claim',{...json({}),headers:headers(identity)}),
 select:(identity:CalendarIdentity,id:string,target_id:string)=>request<CalendarOperation>(device(identity)+'/operations/'+encodeURIComponent(id)+'/target',{...json({target_id}),headers:headers(identity)}),
 receipt:(identity:CalendarIdentity,id:string,token:string,receipt:CalendarReceipt)=>request<CalendarProgress>(device(identity)+'/operations/'+encodeURIComponent(id)+'/receipts',{...json({token,receipt}),headers:headers(identity)}),
}
