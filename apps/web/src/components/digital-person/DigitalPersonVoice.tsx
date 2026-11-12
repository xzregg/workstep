import { useEffect, useRef, useState } from 'react'
import Button from '../Button'
import { useI18n } from '../../i18n'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import type { DigitalPersonProfile } from '../../api/digitalPerson'

export default function DigitalPersonVoice({ profile }: { profile: DigitalPersonProfile }) {
  const { t } = useI18n()
  const [speaking, setSpeaking] = useState(false)
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
    speech.lang = 'zh-CN'; utterance.current = speech
    speech.onstart = () => setSpeaking(true)
    speech.onend = () => { setSpeaking(false); utterance.current = null }
    speech.onerror = () => { setSpeaking(false); utterance.current = null; setError(t('digitalPerson.voiceFailed')) }
    window.speechSynthesis.speak(speech)
  }
  return <div className="digital-person-voice">
    <DigitalPersonAvatar avatar={profile.avatar} speaking={speaking} />
    <p>{t('digitalPerson.voiceHint')}</p>
    <Button disabled={!supported} onClick={speaking ? stop : play}>{t(speaking ? 'digitalPerson.stopVoice' : 'digitalPerson.tryVoice')}</Button>
    {!supported && <p>{t('digitalPerson.voiceUnavailable')}</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
