import { createRoot } from 'react-dom/client'
import EngineSettingsPanel from '../../../src/components/EngineSettingsPanel'
import { engineApi, type EngineInfo, type EngineLoginState } from '../../../src/api/engine'
import { I18nProvider, useLocaleStore } from '../../../src/i18n'
import '../../../src/index.css'
import '../../../src/mobile.css'

useLocaleStore.getState().setLocale('zh-CN')
let state: EngineLoginState | null = null
const submissions: string[] = []
engineApi.list = async () => ({ engines:[{
  id:'antigravity', name:'Antigravity', installed:true, configured:true, verified:false, enabled:true,
  supports_login:true, mode:'acp', provider_protocols:[], supports_coordinator:true,
  config:{fields:[],step_fields:[],values:{},secrets:{}},
} as unknown as EngineInfo] })
engineApi.executionConfig = async () => ({ engine:'antigravity',resolved_engine:'antigravity' })
engineApi.models = async () => ({ engine_id:'antigravity',models:[{id:'gemini',label:'Gemini'}],default_model:'',error:null })
engineApi.loginStatus = async () => state
engineApi.startLogin = async () => state = {id:'fixture',phase:'waiting_code',authorization_url:'https://accounts.google.com/o/oauth2/auth?state=fixture',error:null}
engineApi.submitLoginCode = async (_engine, _id, code) => {
  submissions.push(code)
  return state = {id:'fixture',phase:'submitting',authorization_url:null,error:null}
}
engineApi.cancelLogin = async () => state = {id:'fixture',phase:'cancelled',authorization_url:null,error:null}
Object.assign(window, { engineLoginFixture:{
  succeed: () => { state = {id:'fixture',phase:'succeeded',authorization_url:null,error:null} },
  fail: () => { state = {id:'fixture',phase:'failed',authorization_url:null,error:'login_timeout'} },
  submissions: () => submissions,
} })
createRoot(document.getElementById('root')!).render(<I18nProvider>
  <EngineSettingsPanel hidden={false} refreshRevision={0} preferredProviderProtocol="" />
</I18nProvider>)
