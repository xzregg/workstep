import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { getProductIntroMedia } from '../config/productIntro'
import { playVideoOnDemand } from '../demo/playVideoOnDemand'
import { useI18n, type Lang } from '../i18n'
import { productIntroCopy } from '../i18n/productIntro'
import './ProductIntro.css'

type VideoProps = { locale: Lang; errorLabel: string; retryLabel: string }

function VideoPlayer({ locale, errorLabel, retryLabel }: VideoProps) {
  const media = getProductIntroMedia(locale)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [started, setStarted] = useState(false)
  const play = () => {
    const video = videoRef.current
    if (!video) return
    setStarted(true)
    void playVideoOnDemand(video, media.src).catch(() => setFailed(true))
  }
  useEffect(() => {
    const video = videoRef.current
    return () => { video?.pause() }
  }, [])

  return <div className="product-intro-player" dir="ltr">
    <video ref={videoRef} controls={started} playsInline preload="none" poster={media.poster} aria-label={productIntroCopy[locale].title} onError={() => setFailed(true)}>
      {started && <track kind="captions" src={media.captions} srcLang={media.language} label={media.language === 'zh' ? '中文' : 'English'} />}
    </video>
    {!started && <button type="button" className="product-intro-play" aria-label={productIntroCopy[locale].title} onClick={play}><Play size={48} /></button>}
    {failed && <div className="product-intro-error" role="status"><p>{errorLabel}</p><button type="button" className="btn btn-primary" onClick={() => { setFailed(false); videoRef.current?.load(); play() }}>{retryLabel}</button></div>}
  </div>
}

export function ProductIntroVideo(props: VideoProps) {
  return <VideoPlayer key={getProductIntroMedia(props.locale).language} {...props} />
}

export function ProductIntro() {
  const { lang, t } = useI18n()
  const copy = productIntroCopy[lang]
  const chinese = getProductIntroMedia(lang).language === 'zh'
  return <section className="product-intro container" id="intro-video" aria-labelledby="product-intro-title">
    <div className="product-intro-heading"><h2 className="section-title" id="product-intro-title">{copy.title}</h2><p className="section-lede">{copy.description}</p></div>
    <ProductIntroVideo locale={lang} errorLabel={t('walkthrough.loadError')} retryLabel={t('walkthrough.retry')} />
    <p className="product-intro-language" lang={chinese ? 'zh' : 'en'}>{chinese ? '中文配音 · 中文字幕' : 'English voiceover · English subtitles'}</p>
  </section>
}
