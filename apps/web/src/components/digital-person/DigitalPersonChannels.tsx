import { useEffect, useState } from 'react'
import { digitalRuntimeApi, type DigitalPeer } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Select from '../Select'
import ConfirmDialog from '../ConfirmDialog'
import Spinner from '../Spinner'
import './DigitalPersonChannels.css'

export default function DigitalPersonChannels({ name, onDirtyChange }: {workspaceId?: string; name: string; onDirtyChange?: (dirty: boolean)=>void}) {
  const {t} = useI18n()
  const [data,setData] = useState<{available:DigitalPeer[];bindings:DigitalPeer[]}>({available:[],bindings:[]})
  const [bot,setBot] = useState(''), [peer,setPeer] = useState(''), [notify,setNotify] = useState(false)
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [revision,setRevision] = useState(0), [testPeer,setTestPeer] = useState<DigitalPeer|null>(null), [receipt,setReceipt] = useState('')
  useEffect(()=>{onDirtyChange?.(busy || !!peer);return ()=>onDirtyChange?.(false)},[busy,peer,onDirtyChange])
  useEffect(()=>{
    let active=true;setLoading(true)
    digitalRuntimeApi.channels().then(value=>{if(active){setData(value);setError('')}}).catch(e=>{if(active)setError(String(e))}).finally(()=>{if(active)setLoading(false)})
    return ()=>{active=false}
  },[revision])
  const action = async (fn:()=>Promise<unknown>) => {
    if(busy)return
    setBusy(true);setError('');setReceipt('')
    try{await fn();setPeer('');setRevision(v=>v+1)}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  const bots = [...new Map([...data.available,...data.bindings].map(p=>[p.bot_id,p])).values()]
  return <section className="digital-person-channels">
    {loading && <Spinner/>}{error && <p role="alert">{error}</p>}{receipt && <p role="status">{receipt}</p>}
    <Button disabled={loading || busy} onClick={()=>setRevision(v=>v+1)}>{t('settings.refresh')}</Button>
    <label>{t('digitalPerson.selectBot')}<Select value={bot} disabled={busy} onChange={e=>{setBot(e.target.value);setPeer('')}}><option value="">{t('digitalPerson.selectBot')}</option>{bots.map(p=><option key={p.bot_id} value={p.bot_id}>{p.bot_name}</option>)}</Select></label>
    <label>{t('digitalPerson.targetConversation')}<Select value={peer} disabled={busy || !bot} onChange={e=>setPeer(e.target.value)}><option value="">{t('digitalPerson.targetConversation')}</option>{data.available.filter(p=>p.bot_id===bot).map(p=><option key={p.id} value={p.id}>{p.title || p.id}</option>)}</Select></label>
    <label className="digital-person-channel-check"><input type="checkbox" checked={notify} disabled={busy} onChange={e=>setNotify(e.target.checked)}/>{t('digitalPerson.allowNotifications')}</label>
    <Button disabled={busy || !peer} loading={busy} onClick={()=>void action(()=>digitalRuntimeApi.bind(data.available.find(p=>p.id===peer)!,notify))}>{t('digitalPerson.bindBot')}</Button>
    {!loading && !data.available.length && <p>{t('digitalPerson.noChannelConversations')}</p>}
    {data.bindings.map(p=><div className="digital-person-channel" key={p.id}><div><strong>{p.bot_name}</strong><span>{p.title}</span><small>{t(p.notify?'digitalPerson.allowNotifications':'digitalPerson.replyOnly')}</small></div><div className="digital-person-actions"><Button disabled={busy} onClick={()=>setTestPeer(p)}>{t('digitalPerson.testDelivery')}</Button><Button disabled={busy} onClick={()=>void action(()=>digitalRuntimeApi.unbind(p.id))}>{t('digitalPerson.unbind')}</Button></div></div>)}
    <ConfirmDialog open={!!testPeer} title={t('digitalPerson.testDelivery')} message={t('digitalPerson.testDeliveryConfirm',{name,bot:testPeer?.bot_name || '',target:testPeer?.title || ''})} loading={busy} onCancel={()=>{if(!busy)setTestPeer(null)}} onConfirm={()=>void action(async()=>{await digitalRuntimeApi.test(testPeer!.id);setReceipt(t('digitalPerson.deliverySuccess'));setTestPeer(null)})}>{error && <p role="alert">{error}</p>}</ConfirmDialog>
  </section>
}
