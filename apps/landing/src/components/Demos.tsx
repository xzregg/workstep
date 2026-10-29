import { useRef, useState } from 'react'
import { Maximize2, Play } from 'lucide-react'
import { DEMOS, type DemoDef } from '../demo/demos'
import { useI18n } from '../i18n'
import { DemoPlayer } from './DemoPlayer'

export function Demos({ onOpen }: { onOpen: (demo: DemoDef) => void }) {
  const { t } = useI18n()
  const [selected, setSelected] = useState(0)
  const [revision, setRevision] = useState(0)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const choose = (index: number, focus = false) => {
    setSelected(index); setRevision(value => value + 1)
    if (focus) buttons.current[index]?.focus()
  }
  return <section className="section mechanism-gallery" id="mechanisms"><div className="container">
    <div className="editorial-section-heading"><div><p className="section-eyebrow">{t('demos.eyebrow')}</p><h2 className="section-title">{t('demos.title')}</h2></div><p className="section-lede">{t('demos.lede')}</p></div>
    <div className="mechanism-tabs" role="tablist" aria-label={t('demos.title')}>
      {DEMOS.map((demo, index) => <button type="button" key={demo.id} ref={node => { buttons.current[index] = node }} id={`mechanism-tab-${index}`} role="tab" aria-selected={selected === index} aria-controls="mechanism-panel" tabIndex={selected === index ? 0 : -1} onClick={() => choose(index)} onKeyDown={event => {
        let next = selected
        if (event.key === 'ArrowRight') next = (selected + 1) % DEMOS.length
        else if (event.key === 'ArrowLeft') next = (selected + DEMOS.length - 1) % DEMOS.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = DEMOS.length - 1
        else return
        event.preventDefault(); choose(next, true)
      }}><Play size={17} aria-hidden="true" /><span>{t(`demos.item${index + 1}Title`)}<small>{demo.durationMs / 1000}s · {t('common.play')}</small></span></button>)}
    </div>
    <div className="mechanism-panel" id="mechanism-panel" role="tabpanel" aria-labelledby={`mechanism-tab-${selected}`} tabIndex={0}>
      <div className="mechanism-toolbar"><p>{t(`demos.item${selected + 1}Desc`)}</p><button type="button" aria-label={t('demos.hint')} onClick={() => onOpen(DEMOS[selected])}><Maximize2 size={17} /></button></div>
      <DemoPlayer key={`${selected}-${revision}`} demo={DEMOS[selected]} autoplay={revision > 0} loop={false} />
    </div>
  </div></section>
}
