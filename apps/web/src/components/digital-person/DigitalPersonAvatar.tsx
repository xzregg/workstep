import Icon from '../Icon'
export default function DigitalPersonAvatar({ avatar, speaking = false }: { avatar: 'robot' | 'spark'; speaking?: boolean }) {
  return <div className={`digital-person-avatar ${speaking ? 'is-speaking' : ''}`} aria-hidden="true">
    <Icon name={avatar === 'robot' ? 'bot' : 'sparkles'} size={96} strokeWidth={1.25} />
    {speaking && <span className="digital-person-voice-bars"><i /><i /><i /></span>}
  </div>
}
