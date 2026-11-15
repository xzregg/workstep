import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import Pricing from '../src/pages/ModelPricingSettings'
import VoiceOutputSettings from '../src/components/VoiceOutputSettings'
import {systemSettingsApi} from '../src/api/client'
import {digitalPersonApi} from '../src/api/digitalPerson'
import {speechOutputApi} from '../src/api/speechOutput'
import {outputStatus} from './fixtures/speechOutput'

function harness(){
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const input=async(el:HTMLInputElement,value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}))})
 return {host,root,input,close:async()=>{await act(async()=>root.unmount());await window.happyDOM.close()}}
}
test('exchange rate and prices allow empty drafts and reject empty or negative submission',async()=>{
 const ui=harness(),original={...systemSettingsApi}
 let submitted:any,calls=0
 const config={currency:'CNY',usd_to_cny_rate:7,prices:[{provider_id:'p',engine_id:null,model:'m',model_type:'chat',supports_multimodal:false,input_price:2,output_price:3,cache_price:0}],providers:[{id:'p',name:'测试',models:[{id:'m'}]}],engines:[],standalone_models:[]}
 systemSettingsApi.modelSettings=async()=>config as any
 systemSettingsApi.saveModelSettings=async value=>{calls++;submitted=value;return value as any}
 try{
  await act(async()=>ui.root.render(<I18nProvider><Pricing/></I18nProvider>))
  const rate=ui.host.querySelector<HTMLInputElement>('input[type=number]')!,save=ui.host.querySelector<HTMLButtonElement>('.btn-primary')!
  await ui.input(rate,'');assert.equal(rate.value,'');assert.equal(save.disabled,true)
  await act(async()=>save.click());assert.equal(calls,0)
  await ui.input(rate,'8.1');assert.equal(rate.value,'8.1');assert.equal(save.disabled,false)
  const price=ui.host.querySelector<HTMLInputElement>('tbody input[type=number]')!
  await ui.input(price,'');assert.equal(price.value,'');assert.equal(save.disabled,true)
  await ui.input(price,'-2');assert.equal(price.value,'-2');assert.equal(save.disabled,true)
  await ui.input(price,'0.25');assert.equal(price.value,'0.25');assert.equal(save.disabled,false)
  await act(async()=>save.click());assert.equal(calls,1);assert.equal(submitted.usd_to_cny_rate,8.1);assert.equal(submitted.prices[0].input_price,.25)
 }finally{await ui.close();Object.assign(systemSettingsApi,original)}
})
test('speech rate and volume remain empty until retyped and do not save blank values',async()=>{
 const ui=harness(),oldOutput={...speechOutputApi},oldPerson={...digitalPersonApi};let submitted:any
 const profile={enabled:true,name:'小研',role:'伙伴',personality:'',duties:'工作',avatar:'robot' as const,greeting:'你好'}
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 speechOutputApi.save=async value=>{submitted=value;return value}
 digitalPersonApi.get=async()=>profile
 digitalPersonApi.save=async value=>value
 try{
  await act(async()=>ui.root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={()=>{}}/></I18nProvider>))
  const inputs=ui.host.querySelectorAll<HTMLInputElement>('.speech-output-row input[type=number]'),save=ui.host.querySelector<HTMLButtonElement>('[data-save-output]')!
  for(const [index,value] of ['1.2','0.7'].entries()){
   await ui.input(inputs[index],'');assert.equal(inputs[index].value,'');assert.equal(save.disabled,true)
   await ui.input(inputs[index],value);assert.equal(inputs[index].value,value);assert.equal(save.disabled,false)
  }
  await act(async()=>save.click());assert.equal(submitted.rate,1.2);assert.equal(submitted.volume,.7)
 }finally{await ui.close();Object.assign(speechOutputApi,oldOutput);Object.assign(digitalPersonApi,oldPerson)}
})
