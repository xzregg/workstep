import Button from '../Button'
import {useEffect} from 'react'
import {useI18n} from '../../i18n'
import {openNativeCalendar,useNativeCalendarStore} from '../../stores/nativeCalendarStore'
import './NativeCalendarControl.css'
export default function NativeCalendarSettings(){
 const {t}=useI18n(),state=useNativeCalendarStore()
 useEffect(()=>{void useNativeCalendarStore.getState().refresh().catch(()=>{})},[])
 return <div className="settings-system-group"><h2 className="settings-system-heading">{t('nativeCalendar.title')}</h2><div className="native-calendar-setting-actions"><label className="native-calendar-sync"><input type="checkbox" disabled={!state.owner} checked={state.syncEnabled} onChange={event=>{state.setSyncEnabled(event.target.checked);if(event.target.checked&&(state.defaultTarget==='internal'||state.localDevice?.permission!=='granted'))openNativeCalendar()}}/>{t('nativeCalendar.sync')}</label>{state.syncEnabled&&<Button onClick={openNativeCalendar}>{t('nativeCalendar.select')}</Button>}</div></div>
}
