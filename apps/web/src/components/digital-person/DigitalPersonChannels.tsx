import { useEffect, useState } from 'react'
import { digitalRuntimeApi, type DigitalPeer } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import Button from '../Button'
import Select from '../Select'
import ConfirmDialog from '../ConfirmDialog'
import './DigitalPersonChannels.css'

export default function DigitalPersonChannels({ name, onDirtyChange, onBusyChange }: {workspaceId?: string; name: string; onDirtyChange?: (dirty: boolean)=>void; onBusyChange?: (busy: boolean)=>void}) {
  const {t} = useI18n()
  const [data,setData] = useState<{available:DigitalPeer[];bindings:DigitalPeer[]}>({available:[],bindings:[]})
  const [adding,setAdding] = useState(false)
  const [bot,setBot] = useState(''), [peer,setPeer] = useState(''), [notify,setNotify] = useState(false)
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const [revision,setRevision] = useState(0), [testPeer,setTestPeer] = useState<DigitalPeer|null>(null), [receipt,setReceipt] = useState('')
  useEffect(()=>{onBusyChange?.(busy)},[busy,onBusyChange])
  useEffect(()=>()=>onBusyChange?.(false),[onBusyChange])
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
    {error && <p role="alert">{error}</p>}{receipt && <p role="status">{receipt}</p>}
    <header className="digital-person-channels-header settings-heading-row"><h2 id="digital-person-panel-title">{t('digitalPerson.channels')}</h2><Button variant="ghost" loading={loading} disabled={loading || busy} onClick={()=>setRevision(v=>v+1)}>{t('settings.refresh')}</Button></header>
    {data.bindings.map(p=><div className="digital-person-channel" key={p.id}><div><strong>{p.bot_name}</strong><span>{p.title}</span><small>{t(p.notify?'digitalPerson.allowNotifications':'digitalPerson.replyOnly')}</small></div><div className="digital-person-actions"><Button disabled={busy} onClick={()=>setTestPeer(p)}>{t('digitalPerson.testDelivery')}</Button><Button disabled={busy} onClick={()=>void action(()=>digitalRuntimeApi.unbind(p.id))}>{t('digitalPerson.unbind')}</Button></div></div>)}
    {adding ? <div className="digital-person-channel-form">
    <label>{t('digitalPerson.selectBot')}<Select value={bot} disabled={busy} onChange={e=>{setBot(e.target.value);setPeer('')}}><option value="">{t('digitalPerson.selectBot')}</option>{bots.map(p=><option key={p.bot_id} value={p.bot_id}>{p.bot_name}</option>)}</Select></label>
    <label>{t('digitalPerson.targetConversation')}<Select value={peer} disabled={busy || !bot} onChange={e=>setPeer(e.target.value)}><option value="">{t('digitalPerson.targetConversation')}</option>{data.available.filter(p=>p.bot_id===bot).map(p=><option key={p.id} value={p.id}>{p.title || p.id}</option>)}</Select></label>
    <label className="digital-person-channel-check"><input type="checkbox" checked={notify} disabled={busy} onChange={e=>setNotify(e.target.checked)}/>{t('digitalPerson.allowNotifications')}</label>
    {!loading && !data.available.length && <p>{t('digitalPerson.noChannelConversations')}</p>}
    <div className="digital-person-channel-form-actions settings-action-group">
    <Button disabled={busy || !peer} loading={busy} onClick={()=>void action(async()=>{await digitalRuntimeApi.bind(data.available.find(p=>p.id===peer)!,notify);setAdding(false);setBot('');setNotify(false)})}>{t('digitalPerson.bindBot')}</Button>
    <Button disabled={busy} onClick={()=>{setAdding(false);setBot('');setPeer('');setNotify(false);setError('')}}>{t('common.cancel')}</Button>
    </div>
    </div> : <Button disabled={loading || busy} onClick={()=>setAdding(true)}>{t('common.add')}</Button>}
    <ConfirmDialog open={!!testPeer} title={t('digitalPerson.testDelivery')} message={t('digitalPerson.testDeliveryConfirm',{name,bot:testPeer?.bot_name || '',target:testPeer?.title || ''})} loading={busy} onCancel={()=>{if(!busy)setTestPeer(null)}} onConfirm={()=>void action(async()=>{await digitalRuntimeApi.test(testPeer!.id);setReceipt(t('digitalPerson.deliverySuccess'));setTestPeer(null)})}>{error && <p role="alert">{error}</p>}</ConfirmDialog>
  </section>
}
