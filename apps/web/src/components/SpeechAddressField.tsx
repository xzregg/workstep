import { useId } from 'react'
import { useI18n } from '../i18n'
import Input from './Input'

export default function SpeechAddressField({ value, addresses, placeholder, onChange }: {
  value: string; addresses: string[]; placeholder?: string; onChange: (value: string) => void
}) {
  const id = useId()
  const { t } = useI18n()
  return <label>{t('tts.baseUrl')}
    <Input value={value} list={addresses.length ? id : undefined} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    <datalist id={id}>{addresses.map(address => <option key={address} value={address} />)}</datalist>
  </label>
}
