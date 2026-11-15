import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { digitalMemoryApi, type MemorySource, type MemorySourcePage } from '../../api/digitalPerson'
import { useI18n } from '../../i18n'
import { useOverlay } from '../../hooks/useOverlay'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import Button from '../Button'
import Spinner from '../Spinner'
import ResizablePanel from '../ResizablePanel'

export default function DigitalPersonMemorySource({source,onClose}:{source:MemorySource;onClose:()=>void}) {
  const {t}=useI18n(), ref=useRef<HTMLDivElement>(null)
  const [page,setPage]=useState<MemorySourcePage|null>(null),[content,setContent]=useState('')
  const [offset,setOffset]=useState(0),[revision,setRevision]=useState(0)
  const [loading,setLoading]=useState(true),[error,setError]=useState(false),[changed,setChanged]=useState(false)
  const hash=useRef(''), busy=useRef(false)
  useOverlay(true,onClose,ref,useCompactLayout())
  useEffect(()=>{
    let live=true
    busy.current=true;setLoading(true);setError(false)
    void digitalMemoryApi.read(source.id,offset).then(result=>{
      if(!live)return
      if(hash.current && hash.current!==result.source_hash){setChanged(true);setContent('');setPage(null);return}
      hash.current=result.source_hash;setPage(result);setContent(value=>offset===0?result.content:value+result.content)
    },()=>{if(live)setError(true)}).finally(()=>{if(live){busy.current=false;setLoading(false)}})
    return()=>{live=false}
  },[source.id,offset,revision])
  return createPortal(<div className="digital-memory-source-backdrop" onClick={onClose}>
    <ResizablePanel ref={ref} role="dialog" aria-modal="true" aria-label={t('digitalMemoryView.sourceTitle')} tabIndex={-1} className="digital-memory-source-panel" onClick={e=>e.stopPropagation()}>
      <header data-dialog-drag-handle><h2>{t('digitalMemoryView.sourceTitle')}</h2><Button data-memory-close onClick={onClose}>{t('digitalMemoryView.close')}</Button></header>
      <div className="digital-memory-source-body"><p className="digital-memory-muted">{source.project_name} · {source.source_time.replace('T',' ')} · {source.role}</p>
        {content && <blockquote>{content}</blockquote>}
        {loading && <p role="status"><Spinner/>{t('digitalMemoryView.loading')}</p>}
        {error && <p role="alert">{t('digitalMemoryView.sourceError')}</p>}
        {changed && <p role="alert">{t('digitalMemoryView.sourceChanged')}</p>}
      </div>
      <footer>{page && <span>{t('digitalMemoryView.position',{count:content.length,total:page.total_chars})}</span>}
        {error && <Button onClick={()=>{if(!busy.current){busy.current=true;setRevision(v=>v+1)}}}>{t('common.retry')}</Button>}
        {page?.has_more && !error && <Button data-memory-next loading={loading} onClick={()=>{if(!busy.current && page.next_offset!==null){busy.current=true;setOffset(page.next_offset)}}}>{t('digitalMemoryView.more')}</Button>}
      </footer>
    </ResizablePanel>
  </div>,document.body)
}
