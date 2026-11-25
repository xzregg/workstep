import { localizeErrorDisplay } from '../i18n'
import {useEffect,useRef,useState} from 'react'
import {Navigate,useMatch,useNavigate} from 'react-router-dom'
import {digitalPersonApi,type DigitalPersonProfile} from '../api/digitalPerson'
import {resolveDigitalPersonChat} from '../components/digital-person/digitalPersonChat'
import {DIGITAL_PERSON_CHANGED} from '../components/digital-person/useDigitalPerson'
import {useProjectStore} from '../stores/projectStore'
import {useGatewayProjectPermissions} from '../hooks/useGatewayProjectPermissions'
import {useI18n} from '../i18n'
import Button from '../components/Button'
import {ProjectPermissionGate} from '../components/ProjectPermissionGate'
import Spinner from '../components/Spinner'
import ChatPage from './ChatPage'

export function DigitalPersonHomeRoute(){
 const active=Boolean(useMatch('/companion'))
 const projectId=useProjectStore(s=>s.activeProject?.id)
 const [visitedProject,setVisitedProject]=useState<string|undefined>()
 if(active&&projectId!==visitedProject)setVisitedProject(projectId)
 if(!active&&visitedProject&&visitedProject!==projectId)setVisitedProject(undefined)
 if(!active&&(!visitedProject||visitedProject!==projectId))return null
 return <div hidden={!active} style={active?{display:'contents'}:undefined}>
  <ProjectPermissionGate permission="session.read"><DigitalPersonHomePage active={active}/></ProjectPermissionGate>
 </div>
}

/** Resolve the existing device main chat; its data/engine still belong to ChatPage. */
export default function DigitalPersonHomePage({active=true}:{active?:boolean}){
 const home=useProjectStore(s=>s.projects.find(p=>p.is_default_workspace&&p.type!=='remote'))
 const {bound}=useGatewayProjectPermissions(home?.id),{t}=useI18n(),navigate=useNavigate()
 const [data,setData]=useState<{projectId:string;profile:DigitalPersonProfile;sid:string}|null>(null),[error,setError]=useState(''),[revision,retry]=useState(0)
 const [refreshing,setRefreshing]=useState(true)
 const current=useRef(data);current.current=data
 useEffect(()=>{
  if(!home||bound)return
  let alive=true,pending=false,again=false
  const load=async()=>{
   if(pending){again=true;return}
   pending=true
   setRefreshing(true)
   try{
    const profile=await digitalPersonApi.get()
    const sid=profile.enabled?((current.current?.projectId===home.id?current.current.sid:'')||await resolveDigitalPersonChat(home.id)):''
    if(alive){setData({projectId:home.id,profile,sid});setError('')}
   }catch(e){if(alive)setError(e instanceof Error?e.message:String(e))}
   finally{pending=false;if(alive)setRefreshing(false);if(again&&alive){again=false;void load()}}
  }
  void load();window.addEventListener(DIGITAL_PERSON_CHANGED,load)
  return()=>{alive=false;window.removeEventListener(DIGITAL_PERSON_CHANGED,load)}
 },[home?.id,bound,revision])
 if(bound)return active?<Navigate replace to="/"/>:null
 if(!home)return <div className="chat-session-empty" role="status"><Spinner/>{t('common.loading')}</div>
 const workbench=`/chat?project=${encodeURIComponent(home.name)}`
 if(error)return <div className="chat-session-empty" role="alert"><p>{localizeErrorDisplay(error)}</p><Button onClick={()=>retry(n=>n+1)}>{t('common.retry')}</Button><Button onClick={()=>navigate(workbench)}>{t('digitalPerson.homeBack')}</Button></div>
 if(!data||data.projectId!==home.id||refreshing&&!data.profile.enabled)return <div className="chat-session-empty" role="status"><Spinner/>{t('common.loading')}</div>
 if(!data.profile.enabled)return active?<Navigate replace to={workbench}/>:null
 return <ChatPage companionProfile={data.profile} pane={{project:home,sessionId:data.sid,active,onSessionChange:id=>{
  if(id)navigate(`${workbench}&session=${encodeURIComponent(id)}`)
  else{current.current=null;setData(null);retry(n=>n+1)}
 }}}/>
}
