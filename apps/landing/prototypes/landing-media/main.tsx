import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Maximize2, Minimize2, Play } from 'lucide-react'
import { I18nProvider, useI18n, supportedLanguages } from '../../src/i18n'
import { GuidedWalkthrough } from '../../src/components/GuidedWalkthrough'
import { DemoPlayer } from '../../src/components/DemoPlayer'
import { DEMOS } from '../../src/demo/demos'
import '../../src/landing.css'
import './media.css'

function MediaPreview() {
  const { t, setLang } = useI18n()
  const [selected, setSelected] = useState(0)
  const [playbackKey, setPlaybackKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')
  const stage = useRef<HTMLElement>(null)
  const selectionButtons = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const sendHeight = () => window.parent.postMessage({ type: 'workstep-prototype-media-height', height: document.getElementById('root')!.getBoundingClientRect().height }, '*')
    const observer = new ResizeObserver(sendHeight)
    observer.observe(document.getElementById('root')!)
    const receiveTheme = (event: MessageEvent) => {
      if (event.source !== window.parent || (event.origin !== location.origin && event.origin !== 'null')) return
      if (event.data?.type === 'workstep-prototype-theme' && ['light', 'dark'].includes(event.data.theme)) {
        document.documentElement.dataset.theme = event.data.theme
        document.documentElement.style.colorScheme = event.data.theme
      }
      if (event.data?.type === 'workstep-prototype-language' && supportedLanguages.some(item => item.locale === event.data.lang)) setLang(event.data.lang)
    }
    window.addEventListener('message', receiveTheme)
    window.parent.postMessage({ type: 'workstep-prototype-media-ready' }, '*')
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === stage.current)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => { observer.disconnect(); window.removeEventListener('message', receiveTheme); document.removeEventListener('fullscreenchange', updateFullscreen) }
  }, [setLang])

  const choose = (index: number, focus = false) => {
    setSelected(index)
    setPlaybackKey(value => value + 1)
    if (focus) selectionButtons.current[index]?.focus()
  }
  const enlarge = async () => {
    try {
      setFullscreenError('')
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stage.current?.requestFullscreen()
    } catch { setFullscreenError('浏览器未允许全屏，可继续在当前页面播放。') }
  }

  return <main className="media-preview">
    <GuidedWalkthrough />
    <section className="animation-gallery" aria-labelledby="animation-heading">
      <div className="animation-heading"><div><h2 id="animation-heading">{t('demos.title')}</h2><p>{t('demos.lede')}</p></div><span>{t('demos.eyebrow')}</span></div>
      <div className="animation-tabs" role="tablist" aria-label={t('demos.title')}>
        {DEMOS.map((demo, index) => <button key={demo.id} ref={node => { selectionButtons.current[index] = node }} type="button" id={`animation-tab-${demo.id}`} role="tab" aria-selected={selected === index} aria-controls="animation-panel" tabIndex={selected === index ? 0 : -1} onClick={() => choose(index)} onKeyDown={event => {
          let next = selected
          if (event.key === 'ArrowRight') next = (selected + 1) % DEMOS.length
          else if (event.key === 'ArrowLeft') next = (selected + DEMOS.length - 1) % DEMOS.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = DEMOS.length - 1
          else return
          event.preventDefault(); choose(next, true)
        }}><Play size={16} aria-hidden="true" /><span><strong>{t(`demos.item${index + 1}Title`)}</strong><small>{demo.durationMs / 1000}s · {t('common.play')}</small></span></button>)}
      </div>
      <section ref={stage} id="animation-panel" className="animation-stage" role="tabpanel" aria-labelledby={`animation-tab-${DEMOS[selected].id}`}>
        <div className="animation-toolbar"><p>{t(`demos.item${selected + 1}Desc`)}</p><button type="button" onClick={() => void enlarge()} aria-label={fullscreen ? t('common.close') : t('demos.hint')}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
        <DemoPlayer key={`${selected}-${playbackKey}`} demo={DEMOS[selected]} autoplay={playbackKey > 0} loop={false} />
        {fullscreenError && <p role="status" className="fullscreen-error">{fullscreenError}</p>}
      </section>
      <p className="animation-disclaimer">{t('demos.lede')}</p>
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<I18nProvider><MediaPreview /></I18nProvider>)
