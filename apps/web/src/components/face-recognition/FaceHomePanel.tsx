import {useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {useI18n} from '../../i18n'
import {useOverlay} from '../../hooks/useOverlay'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import Button from '../Button'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import ResizablePanel from '../ResizablePanel'
import DigitalPersonVisionSettings from './DigitalPersonVisionSettings'
import './FaceRecognition.css'

/** The home entry opens the same Vision settings as the settings page. */
export default function FaceHomePanel({onClose}:{onClose:()=>void}){
 const {t}=useI18n(),compact=useCompactLayout(),panel=useRef<HTMLDivElement>(null)
 const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[discard,setDiscard]=useState(false)
 const close=()=>{if(busy)return;if(dirty)setDiscard(true);else onClose()}
 useOverlay(true,close,panel,compact)
 return createPortal(<>
  <div className="face-home-backdrop" onClick={close}>
   <ResizablePanel ref={panel} className="face-home-panel" minWidth={360} minHeight={320} role="dialog" aria-modal="true" aria-label={t('faceRecognition.title')} tabIndex={-1} onClick={e=>e.stopPropagation()}>
    <header className="face-home-header"><h2>{t('faceRecognition.title')}</h2><Button className="face-home-close" variant="icon" disabled={busy} aria-label={t('common.close')} onClick={close}><Icon name="x"/></Button></header>
    <div className="face-home-content"><DigitalPersonVisionSettings showFaceTitle={false} onDirtyChange={setDirty} onBusyChange={setBusy}/></div>
   </ResizablePanel>
  </div>
  <ConfirmDialog open={discard} title={t('faceRecognition.discardTitle')} message={t('faceRecognition.discardMessage')} confirmText={t('faceRecognition.discard')} onCancel={()=>setDiscard(false)} onConfirm={onClose}/>
 </>,document.body)
}
