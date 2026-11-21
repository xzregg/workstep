import { useEffect, useMemo, useRef, useState } from 'react'
import { prototypeApi, type PrototypeState, type PrototypeDiff } from '../../api/prototype'
import { useI18n, localizeErrorDisplay } from '../../i18n'
import { createPortal } from 'react-dom'
import { useOverlay } from '../../hooks/useOverlay'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import ResizablePanel from '../ResizablePanel'
import Spinner from '../Spinner'
import Icon from '../Icon'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Select from '../Select'
import GitDiffHunks from '../git/GitDiffHunks'
import {parseGitPatch} from '../git/gitDiff'
import {toMilliseconds} from '../../utils/datetime'

export default function PrototypeHistory({projectId, work, onClean, onClose}: {
  projectId: string; work: PrototypeState; onClean: () => void; onClose: () => void
}) {
  const {t,locale} = useI18n()
  const compact=useCompactLayout()
  const [revision,setRevision] = useState(work.history.at(-1)?.id || 'pending')
  const [data,setData] = useState<PrototypeDiff>({diff:''})
  const [file,setFile] = useState('')
  const [split,setSplit] = useState(!compact)
  const [error,setError] = useState('')
  const [retry,setRetry] = useState(0)
  const [confirm,setConfirm] = useState(false)
  const [loading,setLoading] = useState(false)
  const panel=useRef<HTMLDivElement>(null)
  useOverlay(true,onClose,panel,compact)
  useEffect(()=>{
    let active = true
    setLoading(true);setError('')
    prototypeApi(projectId,work.id).diff(revision).then(value=>{if(active){setData(value);setFile(previous=>value.files?.some(item=>item.path===previous)?previous:value.files?.[0]?.path||'')}}).catch(error=>active&&setError(String(error))).finally(()=>active&&setLoading(false))
    return ()=>{active=false}
  },[projectId,work.id,revision,work.history.length,work.status,retry])
  const patch=data.files?.length?data.files.find(item=>item.path===file)?.patch||'':data.diff
  const hunks=useMemo(()=>parseGitPatch(patch),[patch])
  const dateFormat=useMemo(()=>new Intl.DateTimeFormat(locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}),[locale])
  return createPortal(<div className="prototype-history-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <ResizablePanel ref={panel} className="prototype-history-dialog" role="dialog" aria-modal="true" aria-label={t('prototype.history')} tabIndex={-1} minWidth={420} minHeight={320}>
      <header className="prototype-history-header" data-dialog-drag-handle>
        <Icon name="clock"/><strong>{t('prototype.history')}</strong>
        <span>{(work.bytes / 1024 / 1024).toFixed(1)} MB</span>
        <Button variant="ghost" disabled={work.status!=='idle'||!work.history.length} onClick={()=>setConfirm(true)}>{t('prototype.cleanHistory')}</Button>
        <Button variant="icon" className="prototype-history-close" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}><Icon name="x"/></Button>
      </header>
      <div className="prototype-history-body">
        <nav className="prototype-history-revisions" aria-label={t('prototype.history')}>
          {work.pending&&<Button aria-pressed={revision==='pending'} onClick={()=>setRevision('pending')}>{t('prototype.pendingDiff')}</Button>}
          {work.history.slice().reverse().map(item=>{
            const timestamp=toMilliseconds(item.time)
            return <Button key={item.id} variant="ghost" aria-pressed={revision===item.id} onClick={()=>setRevision(item.id)}>
              <span>{item.label}</span>{timestamp!==null&&<time dateTime={new Date(timestamp).toISOString()}>{dateFormat.format(timestamp)}</time>}
            </Button>
          })}
        </nav>
        <div className={`prototype-history-diff${split?' prototype-history-diff--split':' prototype-history-diff--unified'}`} aria-busy={loading}>
          <div className="prototype-history-toolbar">
            {data.files?.length?<Select aria-label={t('git.diff')} value={file} onChange={event=>setFile(event.target.value)}>{data.files.map(item=><option key={item.path} value={item.path}>{item.path}</option>)}</Select>:<span/>}
            <Button variant="ghost" aria-pressed={split} onClick={()=>setSplit(value=>!value)}>{t(split?'git.unified':'git.split')}</Button>
          </div>
          {split&&<div className="git-diff-labels"><span>{t('git.before')}</span><span>{t('git.after')}</span></div>}
          <div className="git-diff-scroll">
            {loading?<div className="prototype-history-empty"><Spinner/></div>:error?<div className="prototype-history-empty" role="alert">{localizeErrorDisplay(error)}<Button onClick={()=>setRetry(value=>value+1)}>{t('git.retry')}</Button></div>:hunks.length?<GitDiffHunks hunks={hunks} split={split} idPrefix="prototype-history-hunk"/>:<p className="prototype-history-empty">{t('prototype.noDiff')}</p>}
          </div>
        </div>
      </div>
    </ResizablePanel>
    <ConfirmDialog open={confirm} title={t('prototype.cleanConfirm')} onCancel={()=>setConfirm(false)} onConfirm={()=>{setConfirm(false);setRevision('pending');onClean()}}/>
  </div>,document.body)
}
