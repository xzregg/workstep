import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import {digitalRuntimeApi} from '../src/api/digitalPerson'
import DigitalPersonGrowth from '../src/components/digital-person/DigitalPersonGrowth'

test('namecard shows real growth, conversation counts and enabled skills from one request',async()=>{
 const {window}=installDomEnvironment(),el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 useLocaleStore.setState({locale:'zh-CN'})
 const old=digitalRuntimeApi.activity;let calls=0
 digitalRuntimeApi.activity=async()=>{calls++;return {level:3,experience:45,next_level_experience:90,session_count:12,reply_count:44,task_count:8,completed_task_count:5,skills:[{id:'review',name:'代码评审'}],feedback:{},suggestions:[],answers:[],runs:[],delegations:[],checking:false}}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonGrowth/></I18nProvider>))
  assert.equal(calls,1)
  const values=[...el.querySelectorAll('dl dd')].map(n=>n.textContent)
  assert.deepEqual(values,['12','44','8','5'])
  assert.match(el.textContent!,/Lv.3/);assert.match(el.textContent!,/代码评审/)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.activity=old;await window.happyDOM.close()}
})
