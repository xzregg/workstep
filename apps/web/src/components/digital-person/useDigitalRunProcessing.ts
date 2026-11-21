import type {DigitalRunProcessing} from '../../api/digitalPerson'
import {useI18n} from '../../i18n'

export function useDigitalRunProcessing(compact=false){
 const {t,fallbackLocale}=useI18n()
 return (processing?:DigitalRunProcessing)=>processing?t(compact?'digitalPerson.runProcessingCompact':'digitalPerson.runProcessing',{
  messages:processing.messages.toLocaleString(fallbackLocale),
  sessions:processing.sessions.toLocaleString(fallbackLocale),
  memories:processing.memories.toLocaleString(fallbackLocale),
 }):''
}
