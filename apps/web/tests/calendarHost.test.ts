import test from 'node:test'
import assert from 'node:assert/strict'
import {installDomEnvironment} from './helpers/domEnv'
import {calendarHost} from '../src/utils/calendarHost'
import {useNativeCalendarStore} from '../src/stores/nativeCalendarStore'
import {nativeCalendarApi} from '../src/api/nativeCalendar'
import type {CalendarOperation} from '../src/api/nativeCalendar'

test('calendar operations stay silent during normal execution and open only when action is needed',()=>{
 for(const status of ['queued','executing','succeeded','cancelled','needs_permission','needs_calendar','needs_device','failed','partial','unknown']){
  useNativeCalendarStore.setState({open:true})
  useNativeCalendarStore.getState().observe({id:'op',status} as CalendarOperation)
  assert.equal(useNativeCalendarStore.getState().open,['needs_permission','needs_calendar','needs_device','failed','partial','unknown'].includes(status),status)
 }
 useNativeCalendarStore.setState({open:false,operation:null})
})

for(const initial of ['not_determined','denied','granted'])test(`calendar authorization opens the appropriate system surface from ${initial}`,async()=>{
 const {window}=installDomEnvironment(),calls:string[]=[]
 let permission=initial
 Object.assign(window,{workstepDesktop:{calendar:{invoke:async(action:string)=>{
  calls.push(action)
  if(action==='permission')permission='granted'
  return {permission,calendars:[]}
 }}}})
 try{
  await calendarHost('test').permission()
  assert.deepEqual(calls,initial==='denied'?['status','settings']:initial==='granted'?['status']:['status','permission'])
 }finally{await window.happyDOM.close()}
})

test('first authorization prefers the local system calendar and preserves an explicit internal choice',async()=>{
 const {window}=installDomEnvironment()
 useNativeCalendarStore.setState({owner:'calendar-preference-test',defaultTarget:'internal',targets:[{id:'phone-calendar',device_id:'phone',name:'个人',permission:'granted',online:true}]})
 try{
  useNativeCalendarStore.getState().preferDevice('phone')
  assert.equal(useNativeCalendarStore.getState().defaultTarget,'phone-calendar')
  useNativeCalendarStore.getState().select('internal')
  useNativeCalendarStore.getState().preferDevice('phone')
  assert.equal(useNativeCalendarStore.getState().defaultTarget,'internal')
 }finally{useNativeCalendarStore.setState({owner:'',defaultTarget:'internal',targets:[],localDevice:null});await window.happyDOM.close()}
})

test('denying the system prompt opens settings without a second click',async()=>{
 const {window}=installDomEnvironment(),calls:string[]=[]
 Object.assign(window,{workstepDesktop:{calendar:{invoke:async(action:string)=>{
  calls.push(action)
  return {permission:action==='status'?'not_determined':'denied',calendars:[]}
 }}}})
 try{
  await calendarHost('test').permission()
  assert.deepEqual(calls,['status','permission','settings'])
 }finally{await window.happyDOM.close()}
})

test('temporarily unavailable calendar selection recovers after reauthorization',async()=>{
 const {window}=installDomEnvironment(),original=nativeCalendarApi.targets
 let available=true
 nativeCalendarApi.targets=async()=>({owner:'restored-owner',items:available?[{id:'restored-target',device_id:'phone',name:'个人',permission:'granted',online:true}]:[]})
 useNativeCalendarStore.setState({owner:'restored-owner'})
 try{
  useNativeCalendarStore.getState().select('restored-target')
  available=false;await useNativeCalendarStore.getState().refresh()
  assert.equal(useNativeCalendarStore.getState().defaultTarget,'internal')
  available=true;await useNativeCalendarStore.getState().refresh()
  assert.equal(useNativeCalendarStore.getState().defaultTarget,'restored-target')
 }finally{nativeCalendarApi.targets=original;useNativeCalendarStore.setState({owner:'',defaultTarget:'internal',targets:[],localDevice:null});await window.happyDOM.close()}
})

test('system sync can be disabled without losing its chosen calendar and stays disabled after refresh',async()=>{
 const {window}=installDomEnvironment(),original=nativeCalendarApi.targets
 nativeCalendarApi.targets=async()=>({owner:'sync-owner',items:[{id:'chosen',device_id:'phone',name:'个人',permission:'granted',online:true}]})
 useNativeCalendarStore.setState({owner:'sync-owner',syncEnabled:false})
 try{
  useNativeCalendarStore.getState().select('chosen')
  useNativeCalendarStore.getState().setSyncEnabled(true)
  await useNativeCalendarStore.getState().refresh()
  assert.equal(useNativeCalendarStore.getState().syncEnabled,true)
  useNativeCalendarStore.getState().setSyncEnabled(false)
  await useNativeCalendarStore.getState().refresh()
  assert.equal(useNativeCalendarStore.getState().syncEnabled,false)
  assert.equal(useNativeCalendarStore.getState().defaultTarget,'chosen')
 }finally{nativeCalendarApi.targets=original;useNativeCalendarStore.setState({owner:'',defaultTarget:'internal',syncEnabled:false,targets:[],localDevice:null});await window.happyDOM.close()}
})
