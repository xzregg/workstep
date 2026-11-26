import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../../../src/i18n'
import NativeCalendarControl from '../../../src/components/native-calendar/NativeCalendarControl'
import DigitalPersonOperations from '../../../src/components/digital-person/DigitalPersonOperations'
import DigitalPersonCalendar from '../../../src/components/digital-person/DigitalPersonCalendar'
import {useNativeCalendarStore} from '../../../src/stores/nativeCalendarStore'
import {defaultSkin} from '../../../src/skins/contract'
import {applySkin} from '../../../src/skins/runtime'
import '../../../src/index.css'
import '../../../src/mobile.css'
useLocaleStore.setState({locale:'zh-CN'})
applySkin(defaultSkin())
Object.assign(window,{nativeCalendarFixture:{operation:()=>useNativeCalendarStore.getState().operation}})
createRoot(document.getElementById('root')!).render(<I18nProvider><DigitalPersonOperations/><DigitalPersonCalendar active projectId="demo" canEdit/><NativeCalendarControl/></I18nProvider>)
