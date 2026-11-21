import {useId,useRef,useState,type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import {useOverlay} from '../../hooks/useOverlay'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import './DigitalPersonActivityDrawer.css'

/** Mobile presentation of the same activity lists and request owner used on desktop. */
export default function DigitalPersonActivityDrawer({available,onOpen,children}:{available:boolean;onOpen:()=>void;children:ReactNode}){
 const compact=useCompactLayout()
 if(!compact)return children
 return available?<MobileActivityDrawer onOpen={onOpen}>{children}</MobileActivityDrawer>:null
}

function MobileActivityDrawer({onOpen,children}:{onOpen:()=>void;children:ReactNode}){
 const {t}=useI18n(),id=useId(),panel=useRef<HTMLDivElement>(null)
 const [open,setShown]=useState(false)
 const close=()=>setShown(false)
 useOverlay(open,close,panel)
 return <>
  <Button variant="ghost" className="digital-home-activity-entry" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" onClick={()=>{onOpen();setShown(true)}}><Icon name="list" size={16}/>{t('digitalPerson.homeProactiveActivity')}</Button>
  {open&&createPortal(<div className="digital-home-activity-backdrop" onClick={close}>
   <div ref={panel} id={id} className="digital-home-activity-dialog" role="dialog" aria-modal="true" aria-label={t('digitalPerson.homeProactiveActivity')} tabIndex={-1} onClick={event=>event.stopPropagation()}>
    <Button variant="icon" className="digital-home-activity-close" aria-label={t('common.close')} onClick={close}><Icon name="x"/></Button>
    {children}
   </div>
  </div>,document.body)}
 </>
}
