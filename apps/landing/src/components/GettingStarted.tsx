import { useRef, useState } from 'react'
import { ArrowRight, Check, ChevronLeft, Maximize2, X } from 'lucide-react'
import { useI18n, languageDirection, type Lang } from '../i18n'
import { editorialCopy } from '../i18n/editorial'
import { getManualChapters, screenshotUrl, type ManualChapter, type ManualScreenshot } from '../manual/content'

const chapterIds = ['sdk-installation', 'sdk-credentials', 'execution-defaults', 'local-projects', 'first-workflow', 'first-task']
export function getGettingStartedSteps(lang: Lang): ManualChapter[] {
  const chapters = getManualChapters(lang)
  return chapterIds.map(id => chapters.find(chapter => chapter.id === id)!)
}

export function GettingStarted() {
  const { t, lang } = useI18n()
  const [index, setIndex] = useState(0)
  const [image, setImage] = useState<ManualScreenshot | null>(null)
  const panel = useRef<HTMLElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const steps = getGettingStartedSteps(lang)
  const chapter = steps[index]
  // Lead with the real directory picker, rather than the default-workspace explanation.
  const sectionIndex = chapter.id === 'local-projects' ? 1 : 0
  const section = chapter.sections[sectionIndex]
  const screenshot = section.screenshot
  const select = (next: number, focus = false) => {
    setIndex(next)
    if (focus) panel.current?.focus()
  }
  return <section className="start-guide section" id="start" lang={lang} dir={languageDirection(lang)} aria-labelledby="start-heading">
    <div className="container">
      <div className="editorial-section-heading"><div><p className="section-eyebrow">02 / {t('manual.groups.getting-started')}</p><h2 className="section-title" id="start-heading">{editorialCopy[lang].startTitle}</h2></div><p className="section-lede">{t('hero.setup')}</p></div>
      <div className="start-routes"><a href="#download">{t('download.title')} <ArrowRight size={16} /></a><a href="#engines">{t('engines.extension')} <ArrowRight size={16} /></a></div>
      <div className="start-layout">
        <div className="start-sidebar"><nav className="start-step-links" aria-label={t('manual.groups.getting-started')}>
          {steps.map((step, i) => <button type="button" className="start-step-link" aria-controls="start-panel" aria-pressed={i === index} key={step.id} data-preview={i === index ? 'true' : undefined} onClick={() => select(i)}><span className="start-number">{String(i + 1).padStart(2, '0')}</span><span>{step.title}</span>{i === index ? <Check size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}</button>)}
        </nav><a className="start-manual" href="#docs">{t('manual.title')} ↗</a></div>
        <article className="start-panel" id="start-panel" ref={panel} aria-labelledby="start-panel-heading" tabIndex={-1}>
          <p className="start-count">0{index + 1} / 0{steps.length}</p><h3 id="start-panel-heading">{chapter.title}</h3><p className="start-summary">{chapter.summary}</p>
          <h4>{section.title}</h4><ol className="start-instructions">{section.steps.map(step => <li key={step}>{step}</li>)}</ol>
          {screenshot && <figure className="start-screenshot"><button type="button" aria-label={`${t('manual.enlarge')}: ${screenshot.alt}`} onClick={() => { setImage(screenshot); dialog.current?.showModal() }}><img src={screenshotUrl(screenshot.id)} alt={screenshot.alt} loading="lazy" /><span><Maximize2 size={14} />{t('manual.enlarge')}</span></button><figcaption>{screenshot.caption}{lang !== 'zh-CN' && <> {t('manual.screenshotNotice')}</>}</figcaption></figure>}
          {section.tips?.map(tip => <p className="start-tip" key={tip}>{tip}</p>)}
          {chapter.sections.filter((_, i) => i !== sectionIndex).map(extra => <section className="start-extra" key={`${lang}-${chapter.id}-${extra.title}`}><h4>{extra.title}</h4><ol className="start-instructions">{extra.steps.map(step => <li key={step}>{step}</li>)}</ol>{extra.tips?.map(tip => <p className="start-tip" key={tip}>{tip}</p>)}</section>)}
          <div className="start-footer"><a href={`#docs/${chapter.id}`}>{t('manual.title')} ↗</a><div>{index > 0 && <button type="button" className="btn btn-ghost start-previous" aria-label={steps[index - 1].title} onClick={() => select(index - 1, true)}><ChevronLeft size={18} /></button>}{index < steps.length - 1 ? <button type="button" className="btn btn-primary" onClick={() => select(index + 1, true)}>0{index + 2} / 0{steps.length}<ArrowRight size={16} /></button> : <a className="btn btn-primary" href="#download">{t('common.download')}<ArrowRight size={16} /></a>}</div></div>
        </article>
      </div>
    </div>
    <dialog className="start-image-dialog" ref={dialog} onClose={() => setImage(null)} onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.current?.close()
    }} aria-label={t('manual.enlarge')}>
      <div className="start-dialog-heading"><p>{image?.alt}</p><button type="button" autoFocus onClick={() => dialog.current?.close()} aria-label={t('common.close')}><X size={20} /></button></div>
      {image && <><img src={screenshotUrl(image.id)} alt={image.alt} /><p>{image.caption}</p>{lang !== 'zh-CN' && <p>{t('manual.screenshotNotice')}</p>}</>}
    </dialog>
  </section>
}
