import { localizeErrorDisplay } from '../../i18n'
import {useEffect,useRef,useState} from 'react'
import {digitalBrowserApi,type DigitalBrowserStatus} from '../../api/digitalPersonBrowser'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Spinner from '../Spinner'
import NativeCalendarSettings from '../native-calendar/NativeCalendarSettings'
import './DigitalPersonOperations.css'

export default function DigitalPersonOperations(){
 const {t}=useI18n()
 const container=useRef<HTMLDivElement>(null),revealed=useRef(false)
 const [data,setData]=useState<DigitalBrowserStatus|null>(null)
 const [error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[revision,refresh]=useState(0)
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>|undefined
  const load=async()=>{
   setLoading(true)
   try{
    const result=await digitalBrowserApi.status()
    if(active){setData(result);setError('');if(result.installing)timer=setTimeout(()=>void load(),2000)}
   }catch(e){if(active)setError(e instanceof Error?e.message:String(e))}
   finally{if(active)setLoading(false)}
  }
  void load()
  return()=>{active=false;clearTimeout(timer)}
 },[revision])
 const action=async(fn:()=>Promise<DigitalBrowserStatus>)=>{
  if(busy)return
  setBusy(true);setError('')
  try{const result=await fn();setData(result);if(result.installing)refresh(n=>n+1)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
  finally{setBusy(false)}
 }
 useEffect(()=>{
  if(data&&!revealed.current){
   revealed.current=true
   if(window.matchMedia('(max-width: 1023px)').matches)container.current?.scrollIntoView?.({block:'start',behavior:'auto'})
  }
 },[data])
 const installing=Boolean(data?.installing)
 return <div ref={container} className="digital-person-operations">
  <NativeCalendarSettings/>
  <div className="digital-person-operation-heading settings-heading-row"><h3>{t('digitalPerson.browserControl')}</h3>
   <Button variant="ghost" data-scan-browser disabled={busy||loading} loading={loading} onClick={()=>refresh(n=>n+1)}>{t('digitalPerson.browserScan')}</Button>
  </div>
  {error&&<p className="digital-person-error" role="alert">{localizeErrorDisplay(error)}</p>}
  {!data&&loading&&<Spinner/>}
  {data&&<article className="digital-person-browser-card" aria-busy={installing}>
   <div className="digital-person-browser-title"><div><strong>Playwright</strong>{data.version&&<span>v{data.version}</span>}</div>
    <span className="digital-person-browser-status">{installing&&<Spinner/>}{t(installing?'digitalPerson.browserInstalling':data.ready?'digitalPerson.browserReady':'digitalPerson.browserMissing')}</span>
   </div>
   <dl className="digital-person-browser-components">
    <div><dt>{t('digitalPerson.browserComponent')}</dt><dd>{t(data.driver?'digitalPerson.browserDetected':'digitalPerson.browserNotDetected')}</dd></div>
    <div><dt>{t('digitalPerson.browserRuntime')}</dt><dd>{t(data.browser?(data.builtin?'digitalPerson.browserBuiltin':'digitalPerson.browserDetected'):'digitalPerson.browserNotDetected')}</dd></div>
   </dl>
   {data.error&&<p className="digital-person-error" role="alert">{localizeErrorDisplay(data.error)}</p>}
   {data.engine_compatible===false&&<p className="digital-person-error">{t('digitalPerson.browserEngineUnsupported')}</p>}
   {data.ready?<label className="digital-person-browser-enable"><span>{t('digitalPerson.browserEnable')}</span>
    <button type="button" role="switch" className="settings-switch" aria-checked={data.enabled} aria-label={t('digitalPerson.browserEnable')} disabled={busy||installing||(data.engine_compatible===false&&!data.enabled)} onClick={()=>void action(()=>digitalBrowserApi.enable(!data.enabled))}><span className="settings-switch-thumb"/></button>
   </label>:<div className="digital-person-browser-install">
    {(!data.node||!data.npm)?<><p>{t('digitalPerson.browserNodeNeeded')}</p><a className="btn btn-primary" href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">{t('digitalPerson.browserDownloadNode')}</a></>:
     <Button variant="primary" data-install-browser loading={busy||installing} disabled={busy||installing} onClick={()=>void action(digitalBrowserApi.install)}>{t('digitalPerson.browserInstall')}</Button>}
   </div>}
  </article>}
 </div>
}
