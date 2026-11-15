import { useI18n } from '../../i18n'
import type { ReactNode } from 'react'
import './DigitalPersonBodyNavigation.css'

export type DigitalPersonBodyPart = 'brain' | 'eyes' | 'ears' | 'mouth' | 'heart' | 'hands' | 'feet'
const parts: DigitalPersonBodyPart[] = ['brain', 'eyes', 'ears', 'mouth', 'heart', 'hands', 'feet']
const image = new URL('../../assets/digital-person-body.webp', import.meta.url).href
const leaders = {
  brain: '457,245 300,200 100,200', eyes: '565,393 780,350 900,350',
  ears: '304,393 230,390 100,390', mouth: '504,492 760,480 900,480',
  heart: '494,589 300,640 150,640', hands: '654,548 820,660 900,660',
  feet: '556,796 700,880 900,880',
}

/** Body navigation shares one real settings panel; markers never own configuration. */
export default function DigitalPersonBodyNavigation({ name, role, selected, disabled, onSelect, children }: {
  name: string; role: string; selected: DigitalPersonBodyPart | null; disabled: boolean
  onSelect: (part: DigitalPersonBodyPart) => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  return <aside className="digital-person-body-navigation">
    <div className="digital-person-body-profile"><h2>{name}</h2><p>{role}</p></div>
    <nav className="digital-person-body-map" aria-label={t('digitalPerson.bodyNavigation')}>
      <div className="digital-person-body-orbit" aria-hidden="true" />
      <img className="digital-person-body-image" src={image} alt="" draggable={false} />
      <svg className="digital-person-body-leaders" viewBox="0 0 1000 1000" aria-hidden="true">
        {parts.map(part => <polyline key={part} points={leaders[part]} />)}
      </svg>
      {parts.map(part => <div className="digital-person-body-target" data-part={part} key={part}>
        <button type="button" className="digital-person-body-point" aria-label={t(`digitalPerson.body${part}`)}
          aria-pressed={selected === part} disabled={disabled} onClick={() => onSelect(part)}><span /></button>
        <button type="button" className="digital-person-body-label" data-body-part={part}
          aria-pressed={selected === part} disabled={disabled} onClick={() => onSelect(part)}>{t(`digitalPerson.body${part}`)}</button>
      </div>)}
    </nav>
    {children}
  </aside>
}
