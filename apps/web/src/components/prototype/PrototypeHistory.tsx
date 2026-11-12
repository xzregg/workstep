import { useEffect, useState } from 'react'
import { prototypeApi, type PrototypeState } from '../../api/prototype'
import { useI18n } from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'

export default function PrototypeHistory({projectId, work, onClean}: {
  projectId: string; work: PrototypeState; onClean: () => void
}) {
  const {t} = useI18n()
  const [revision,setRevision] = useState('pending')
  const [diff,setDiff] = useState('')
  const [confirm,setConfirm] = useState(false)
  useEffect(()=>{
    let active = true
    prototypeApi(projectId,work.id).diff(revision).then(value=>active&&setDiff(value.diff)).catch(error=>active&&setDiff(String(error)))
    return ()=>{active=false}
  },[projectId,work.id,revision,work.history.length,work.status])
  return <section className="prototype-history">
    <div>
      <span>{(work.bytes / 1024 / 1024).toFixed(1)} MB</span>
      <Button variant="ghost" disabled={work.status!=='idle'||!work.history.length} onClick={()=>setConfirm(true)}>{t('prototype.cleanHistory')}</Button>
      {work.pending&&<Button onClick={()=>setRevision('pending')}>{t('prototype.pendingDiff')}</Button>}
      {work.history.slice().reverse().map(item=><Button key={item.id} variant="ghost" onClick={()=>setRevision(item.id)}>{item.label}</Button>)}
    </div>
    <pre>{diff || t('prototype.noDiff')}</pre>
    <ConfirmDialog open={confirm} title={t('prototype.cleanConfirm')} onCancel={()=>setConfirm(false)} onConfirm={()=>{setConfirm(false);setRevision('pending');onClean()}}/>
  </section>
}
