import { useEffect, useRef, useState } from 'react'
import Button from '../Button'
import Select from '../Select'
import { useI18n } from '../../i18n'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import type { DigitalPersonProfile } from '../../api/digitalPerson'

export default function DigitalPersonVoice({ profile, onChange }: { profile: DigitalPersonProfile; onChange?: (patch: Partial<DigitalPersonProfile>)=>void }) {
  const { t } = useI18n()
  const [speaking, setSpeaking] = useState(false)
  const [voices,setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(()=>{const update=()=>setVoices(window.speechSynthesis?.getVoices() || []);update();window.speechSynthesis?.addEventListener('voiceschanged',update);return()=>window.speechSynthesis?.removeEventListener('voiceschanged',update)},[])
  const [error, setError] = useState('')
  const utterance = useRef<SpeechSynthesisUtterance | null>(null)
  const supported = typeof window.speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
  const stop = () => {
    if (utterance.current) {
      utterance.current.onstart = null; utterance.current.onend = null; utterance.current.onerror = null
      window.speechSynthesis.cancel(); utterance.current = null
    }
    setSpeaking(false)
  }
  useEffect(() => () => {
    if (utterance.current) {
      utterance.current.onstart = null; utterance.current.onend = null; utterance.current.onerror = null
      window.speechSynthesis.cancel()
    }
  }, [])
  const play = () => {
    stop(); setError('')
    const speech = new SpeechSynthesisUtterance(`${profile.name}。${profile.greeting}`)
    speech.lang = 'zh-CN'; speech.rate = profile.voice_rate ?? 1; speech.voice = window.speechSynthesis.getVoices().find(v=>v.name===profile.voice_name) ?? null; utterance.current = speech
    speech.onstart = () => setSpeaking(true)
    speech.onend = () => { setSpeaking(false); utterance.current = null }
    speech.onerror = () => { setSpeaking(false); utterance.current = null; setError(t('digitalPerson.voiceFailed')) }
    window.speechSynthesis.speak(speech)
  }
  return <div className="digital-person-voice">
    {onChange && <><label>{t('digitalPerson.voiceName')}<Select value={profile.voice_name || ''} onChange={e=>onChange({voice_name:e.target.value})}><option value="">{t('digitalPerson.systemVoice')}</option>{voices.map(v=><option key={v.voiceURI} value={v.name}>{v.name} ({v.localService?t('digitalPerson.localVoice'):t('digitalPerson.remoteVoice')})</option>)}</Select></label>
    <label>{t('digitalPerson.expression')}<Select value={profile.expression || 'neutral'} onChange={e=>onChange({expression:e.target.value as DigitalPersonProfile['expression']})}>{(['neutral','happy','concern'] as const).map(v=><option key={v} value={v}>{t(`digitalPerson.${v}`)}</option>)}</Select></label></>}
    <div className="digital-person-voice-preview"><DigitalPersonAvatar avatar={profile.avatar} speaking={speaking} expression={profile.expression} />
    <Button disabled={!supported} onClick={speaking ? stop : play}>{t(!supported ? 'digitalPerson.voiceUnavailable' : speaking ? 'digitalPerson.stopVoice' : 'digitalPerson.tryVoice')}</Button></div>
    {error && <p role="alert">{error}</p>}
  </div>
}
