import { ArrowRight, Check, FileText, Play } from 'lucide-react'
import { useI18n } from '../i18n'
import { editorialCopy } from '../i18n/editorial'
import { FlowBackdrop } from './FlowBackdrop'

interface HeroProps { onOpenDemos: () => void; experienceHref: string }
export function Hero({ onOpenDemos, experienceHref }: HeroProps) {
  const { t, lang } = useI18n()
  const copy = editorialCopy[lang]
  return <section className="intro" id="top" aria-labelledby="intro-title">
    <FlowBackdrop />
    <div className="container intro-content">
      <div className="intro-kicker"><span className="intro-dot" />{t('hero.eyebrow')}<span>OPEN SOURCE</span></div>
      <div className="intro-main">
        <div className="intro-copy"><h1 id="intro-title">{copy.titleA}<br /><span>{copy.titleB}</span></h1><p className="intro-description">{t('hero.lede')}</p>
          <div className="intro-actions"><a href={experienceHref} className="btn btn-primary">{t(experienceHref === '/' ? 'common.openWorkspace' : 'hero.ctaPrimary')}<ArrowRight size={17} /></a><button type="button" className="btn btn-ghost" onClick={onOpenDemos}><Play size={15} />{t('hero.ctaSecondary')}</button></div>
          <p className="intro-setup">{t('hero.setup')} <a href="#start">{t('hero.setupGuide')} ↗</a></p>
        </div>
        <div className="intro-art" aria-hidden="true">
          <div className="intro-coordinate">FLOW / 001<span>IDEA → OUTPUT</span></div>
          <div className="intro-orbit intro-orbit-one" /><div className="intro-orbit intro-orbit-two" />
          <div className="intro-request"><span className="intro-slip-label">YOUR REQUEST</span><p>“{copy.request}”</p><div><span className="intro-dot" />{t('heroPreview.statusReady')}<ArrowRight size={16} /></div></div>
          <div className="intro-delivery"><div className="intro-delivery-top"><FileText size={20} /><span>DELIVERABLE</span><Check size={18} /></div><strong>README.md</strong><div className="intro-paper-lines"><i /><i /><i /><i /></div><div className="intro-delivery-bottom">{t('hero.promise')}<ArrowRight size={16} /></div></div>
          <div className="intro-note"><span>＋</span><p>{t('hero.meta2')}</p></div>
        </div>
      </div>
      <div className="intro-bottom"><span>YOUR TOOLS. YOUR WORKFLOW.</span><p>Codex <i>/</i> Claude Code</p><a href="#start">{t('hero.setupGuide')} ↓</a></div>
    </div>
  </section>
}
