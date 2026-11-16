import { useI18n } from '../../i18n'
import type { ReactNode } from 'react'
import './DigitalPersonBodyNavigation.css'

export type DigitalPersonBodyPart = 'brain' | 'eyes' | 'ears' | 'mouth' | 'heart' | 'hands' | 'feet' | 'memory'
const parts: DigitalPersonBodyPart[] = ['brain', 'memory', 'ears', 'eyes', 'heart', 'mouth', 'feet', 'hands']
const mobileX=(x:number)=>500+(x-500)/1.25
const image = new URL('../../assets/digital-person-body.webp', import.meta.url).href
const leaders = {
  brain: '457,245 300,150 100,150', memory: '590,270 730,150 900,150',
  ears: '304,393 230,360 100,360', eyes: '565,393 780,360 900,360',
  heart: '494,589 300,580 150,580', mouth: '504,492 760,580 900,580',
  feet: '556,796 300,800 100,800', hands: '654,548 820,800 900,800',
}


/** Body navigation shares one real settings panel; markers never own configuration. */
export default function DigitalPersonBodyNavigation({ selected, disabled, onSelect, children }: {
  selected: DigitalPersonBodyPart | null; disabled: boolean
  onSelect: (part: DigitalPersonBodyPart) => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  return <aside className="digital-person-body-navigation">
    {children}
    <nav className="digital-person-body-map" aria-label={t('digitalPerson.bodyNavigation')}>
      <img className="digital-person-body-image" src={image} alt="" draggable={false} />
      <svg className="digital-person-body-leaders digital-person-body-leaders--desktop" viewBox="0 0 1000 1000" aria-hidden="true">
        {parts.map(part => <polyline key={part} points={leaders[part]} />)}
      </svg>
      <svg className="digital-person-body-leaders digital-person-body-leaders--mobile" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        {parts.map(part=><polyline key={part} points={leaders[part].replace(/^([\d.]+),/,(_,x)=>`${mobileX(Number(x))},`)}/>)}
      </svg>
      {parts.map(part => <div className="digital-person-body-target" data-part={part} key={part}>
        <button type="button" className="digital-person-body-point" aria-label={t(part==='memory'?'digitalPerson.memory':`digitalPerson.body${part}`)}
          aria-pressed={selected === part} disabled={disabled} onClick={() => onSelect(part)}><span /></button>
        <button type="button" className="digital-person-body-label" id={`digital-person-tab-${part==='brain'?'assistant':part}`} data-body-part={part}
          aria-pressed={selected === part} disabled={disabled} onClick={() => onSelect(part)}>{t(part==='memory'?'digitalPerson.memory':`digitalPerson.body${part}`)}</button>
      </div>)}
    </nav>
  </aside>
}
