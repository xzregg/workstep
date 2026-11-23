import {useEffect,useRef,useState} from 'react'
import {faceApi,type FaceWelcomeSettings as Settings} from '../../api/faces'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Input from '../Input'
import Spinner from '../Spinner'
import SegmentedControl from '../SegmentedControl'
import {FACE_CHANGED} from './runtime'

const limits={
 away_minutes:[1,120], person_cooldown_minutes:[1,1440],
 interval_minutes:[1,1440], hourly_limit:[1,60], daily_limit:[1,240],
} as const
type Setting=keyof typeof limits
type Draft=Omit<Settings,keyof typeof limits|'phrases'> & Record<Setting,string> & {phrases:string}
const fields=Object.keys(limits) as Setting[]
const toDraft=(value:Settings):Draft=>({
 ...value,
 phrases:value.phrases.join('\n'),away_minutes:String(value.away_minutes),person_cooldown_minutes:String(value.person_cooldown_minutes),
 interval_minutes:String(value.interval_minutes),hourly_limit:String(value.hourly_limit),daily_limit:String(value.daily_limit),
})
const tokens=['{name}','{relationship}'] as const

export default function FaceWelcomeSettings({onDirtyChange,onBusyChange}:{onDirtyChange?:(value:boolean)=>void;onBusyChange?:(value:boolean)=>void}){
 const {t}=useI18n()
 const [saved,setSaved]=useState<Draft|null>(null),[draft,setDraft]=useState<Draft|null>(null)
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(false)
 const [attempt,setAttempt]=useState(0),[preview,setPreview]=useState('')
 const textarea=useRef<HTMLTextAreaElement>(null)
 useEffect(()=>{
  let alive=true
  void faceApi.welcomeSettings().then(value=>{
   if(alive){const next=toDraft(value);setSaved(next);setDraft(next)}
  }).catch(()=>{if(alive)setError(true)}).finally(()=>{if(alive)setLoading(false)})
  return()=>{alive=false}
 },[attempt])
 const dirty=JSON.stringify(draft)!==JSON.stringify(saved)
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false)},[dirty,onDirtyChange])
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false)},[busy,onBusyChange])
 if(loading)return <div className="face-camera-status"><Spinner/>{t('common.loading')}</div>
 if(!draft||!saved)return <div className="face-settings-list"><p role="alert">{t('faceWelcome.unavailable')}</p>
  <Button onClick={()=>{setLoading(true);setAttempt(value=>value+1)}}>{t('common.retry')}</Button></div>
 const phrases=draft.phrases.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)
 const invalidPhrases=phrases.length>12||phrases.some(value=>Array.from(value).length>160)
 const invalid=invalidPhrases||fields.some(key=>{
  const value=Number(draft[key]),[min,max]=limits[key]
  return !Number.isInteger(value)||value<min||value>max
 })
 const change=(value:Partial<Draft>)=>{
  setDraft({...draft,...value})
  if(value.phrases!==undefined)setPreview('')
 }
 const field=(key:Setting)=>{
  const [min,max]=limits[key]
  return <label className="face-field" key={key}>{t(`faceWelcome.${key}`)}
   <Input disabled={busy} type="number" min={min} max={max} step={1} value={draft[key]} onChange={event=>change({[key]:event.target.value})}/>
  </label>
 }
 const insert=(token:typeof tokens[number])=>{
  const input=textarea.current
  if(!input)return
  const {selectionStart:start,selectionEnd:end}=input
  change({phrases:draft.phrases.slice(0,start)+token+draft.phrases.slice(end)})
  requestAnimationFrame(()=>{input.focus();input.setSelectionRange(start+token.length,start+token.length)})
 }
 const save=async()=>{
  if(invalid||!dirty||busy)return
  setBusy(true);setError(false)
  try{
   const value=await faceApi.saveWelcome({
    enabled:draft.enabled,phrases:phrases.length?phrases:draft.enabled?[t('faceWelcome.defaultPhrase')]:[],output:draft.output,away_minutes:Number(draft.away_minutes),
    person_cooldown_minutes:Number(draft.person_cooldown_minutes),interval_minutes:Number(draft.interval_minutes),
    hourly_limit:Number(draft.hourly_limit),daily_limit:Number(draft.daily_limit),
   })
   const next=toDraft(value);setSaved(next);setDraft(next)
   window.dispatchEvent(new Event(FACE_CHANGED))
  }catch{setError(true)}finally{setBusy(false)}
 }
 return <div className="face-settings-list face-welcome-settings">
  <div>
   <h2>{t('faceWelcome.title')}</h2>
   <p>{t('faceWelcome.intro')}</p>
  </div>
  <label className="face-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event=>change({enabled:event.target.checked})}/>{t('faceWelcome.enable')}</label>
  <label className="face-field">{t('faceWelcome.phrases')}
   <textarea className="ws-input" ref={textarea} disabled={busy} aria-describedby="face-welcome-phrase-help"
    placeholder={t('faceWelcome.defaultPhrase')} value={draft.phrases} onChange={event=>change({phrases:event.target.value})}/>
   <small id="face-welcome-phrase-help">{t('faceWelcome.phraseHelp')}</small>
  </label>
  <div className="face-welcome-actions" role="group" aria-label={t('faceWelcome.variables')}>
   {tokens.map(token=><Button key={token} disabled={busy} onClick={()=>insert(token)}>{token}</Button>)}
   <Button disabled={invalidPhrases} onClick={()=>{
    const value=phrases.length?phrases[Math.floor(Math.random()*phrases.length)]:t('faceWelcome.defaultPhrase')
    setPreview(value.replace(/\{name\}|\{relationship\}/g,token=>t(token==='{name}'?'faceWelcome.exampleName':'faceWelcome.exampleRelationship')))
   }}>{t('faceWelcome.preview')}</Button>
  </div>
  {preview&&<p className="face-welcome-preview" role="status">{preview}</p>}
  <fieldset className="face-welcome-output" disabled={busy}>
   <legend>{t('faceWelcome.output')}</legend>
   <SegmentedControl ariaLabel={t('faceWelcome.output')} value={draft.output}
    options={[{value:'text',label:t('faceWelcome.text')},{value:'voice',label:t('faceWelcome.voice')}]}
    onChange={output=>change({output})}/>
  </fieldset>
  {draft.output==='voice'&&<p>{t('faceWelcome.voicePrivacy')}</p>}
  <div className="face-welcome-fields">{fields.slice(0,2).map(field)}</div>
  <p>{t('faceWelcome.quiet')}</p>
  <details className="face-welcome-advanced">
   <summary>{t('faceWelcome.advanced')}</summary>
   <div className="face-welcome-fields">{fields.slice(2).map(field)}</div>
  </details>
  {error&&<p role="alert" className="face-error">{t('faceWelcome.unavailable')}</p>}
  {invalid&&<p role="status">{t('faceWelcome.invalid')}</p>}
  <div className="face-footer"><div className="face-button-pair">
   <Button disabled={busy||!dirty} onClick={()=>{setDraft(saved);setPreview('');setError(false)}}>{t('common.cancel')}</Button>
   <Button variant="primary" loading={busy} disabled={!dirty||invalid||busy} onClick={()=>void save()}>{t('common.save')}</Button>
  </div></div>
 </div>
}
