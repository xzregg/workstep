// Real calendar/editor with synthetic API responses supplied by the browser test.
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../../../src/i18n'
import DigitalPersonCalendar from '../../../src/components/digital-person/DigitalPersonCalendar'
import '../../../src/index.css'
import '../../../src/mobile.css'
useLocaleStore.setState({locale:'zh-CN'})
createRoot(document.getElementById('root')!).render(<I18nProvider><DigitalPersonCalendar active projectId="test" canEdit presentation="panel"/></I18nProvider>)
