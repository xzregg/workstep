import {create} from 'zustand'
import {nativeCalendarApi,type CalendarTarget,type CalendarOperation} from '../api/nativeCalendar'
import {gatewayWorkspacePath} from '../utils/gatewayWorkspacePath'
export const NATIVE_CALENDAR_OPEN='workstep:native-calendar-open'
let loading:Promise<void>|null=null
export const useNativeCalendarStore=create<{
 targets:CalendarTarget[];defaultTarget:string;syncEnabled:boolean;owner:string;operation:CalendarOperation|null;open:boolean;error:string
 localDevice:{namespace:string;device_id:string;platform:string;permission:string}|null
 refresh:()=>Promise<void>;select:(target:string)=>void;setSyncEnabled:(enabled:boolean)=>void;preferDevice:(deviceId:string)=>void;observe:(operation:CalendarOperation)=>void
}>((set,get)=>({
 targets:[],defaultTarget:'internal',syncEnabled:false,owner:'',operation:null,open:false,error:'',localDevice:null,
 refresh:()=>loading??(loading=nativeCalendarApi.targets().then(data=>{
  let defaultTarget=get().defaultTarget
  try{defaultTarget=localStorage.getItem('calendar-target:'+gatewayWorkspacePath()+':'+data.owner)||(get().owner===data.owner?defaultTarget:'internal')}catch{if(get().owner!==data.owner)defaultTarget='internal'}
  if(!data.items.some(row=>row.id===defaultTarget))defaultTarget='internal'
  let syncEnabled=get().owner===data.owner?get().syncEnabled:false
  try{const saved=localStorage.getItem('calendar-sync:'+gatewayWorkspacePath()+':'+data.owner);if(saved!==null)syncEnabled=saved==='true';else if(get().owner!==data.owner)syncEnabled=defaultTarget!=='internal'}catch{/* Preserve the in-memory setting. */}
  set({targets:data.items,owner:data.owner,defaultTarget,syncEnabled})
 }).finally(()=>{loading=null})),
 select:defaultTarget=>{try{localStorage.setItem('calendar-target:'+gatewayWorkspacePath()+':'+get().owner,defaultTarget)}catch{/* In-memory selection still works. */}set({defaultTarget})},
 setSyncEnabled:syncEnabled=>{try{localStorage.setItem('calendar-sync:'+gatewayWorkspacePath()+':'+get().owner,String(syncEnabled))}catch{/* In-memory setting still works. */}set({syncEnabled})},
 preferDevice:deviceId=>{
  try{if(localStorage.getItem('calendar-target:'+gatewayWorkspacePath()+':'+get().owner))return}catch{/* Use the available device in memory. */}
  const target=get().targets.find(row=>row.device_id===deviceId&&row.permission==='granted'&&row.available!==false)
  if(target)get().select(target.id)
 },
 observe:operation=>set({operation,open:['needs_permission','needs_calendar','needs_device','failed','partial','unknown'].includes(operation.status),error:''}),
}))
export function openNativeCalendar(){window.dispatchEvent(new Event(NATIVE_CALENDAR_OPEN))}
export function openDigitalCalendar(projectId:string,canEdit:boolean){window.dispatchEvent(new CustomEvent(NATIVE_CALENDAR_OPEN,{detail:{projectId,canEdit}}))}
