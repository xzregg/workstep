import { forwardRef, type ComponentProps, type ReactNode, type Ref } from 'react'
import ResizablePanel from '../ResizablePanel'
import Button from '../Button'
import Icon from '../Icon'
import { useI18n } from '../../i18n'
import './DigitalPersonConversationFrame.css'

type Props = Omit<ComponentProps<typeof ResizablePanel>, 'title' | 'children'> & {
 title:string;projectName?:string;onClose:()=>void;children:ReactNode
 closeRef?:Ref<HTMLButtonElement>
}

/** Shared shell for the home transcript and project execution conversations. */
export default forwardRef<HTMLDivElement,Props>(function DigitalPersonConversationFrame({title,projectName,onClose,children,className='',closeRef,...props},ref){
 const {t}=useI18n()
 return <ResizablePanel ref={ref} minWidth={480} minHeight={360} {...props} className={`digital-person-conversation-frame ${className}`}>
  <header>
   <h2 title={title}>{title}</h2>
   {projectName&&<p className="digital-person-delegation-project" title={projectName}><Icon name="folder" size={14}/><span>{projectName}</span></p>}
   <Button ref={closeRef} variant="icon" className="digital-person-delegation-close" aria-label={t('common.close')} onClick={onClose}><Icon name="x"/></Button>
  </header>
  <div className="digital-person-delegation-content">{children}</div>
 </ResizablePanel>
})
