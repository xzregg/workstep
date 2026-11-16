import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../../../src/i18n'
import DigitalPersonVisionSettings from '../../../src/components/face-recognition/DigitalPersonVisionSettings'
import DigitalPersonCamera from '../../../src/components/digital-person/DigitalPersonCamera'
import {useState} from 'react'
import '../../../src/index.css'
import '../../../src/mobile.css'
import './style.css'
function Fixture(){const [sent,setSent]=useState('');return <I18nProvider><main className="face-implementation-fixture"><h1>视觉</h1><DigitalPersonVisionSettings/><hr/><section><h2>共享输入摄像头 · 验证入口</h2><DigitalPersonCamera projectId="demo" onPrepare={fn=>{(window as any).sendCamera=fn?async()=>setSent(await fn('看看画面',ids=>{(window as any).sentFaceIds=ids})):null}}/><pre id="sent-message">{sent}</pre></section></main></I18nProvider>}
createRoot(document.getElementById('root')!).render(<Fixture/> )
