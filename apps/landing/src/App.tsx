import { useEffect, useState } from 'react'
import { ManualPage } from './manual/ManualPage'
import { getManualChapterId, isManualHash } from './manual/content'
import { Compare } from './components/Compare'
import { Channels } from './components/Channels'
import { Demos } from './components/Demos'
import { DemoModal } from './components/DemoModal'
import { EnginesStrip } from './components/EnginesStrip'
import { Features } from './components/Features'
import { FinalCta } from './components/FinalCta'
import { Footer } from './components/Footer'
import { Hero } from './components/Hero'
import { Nav } from './components/Nav'
import { RemoteShare } from './components/RemoteShare'
import { Workflow } from './components/Workflow'
import type { DemoDef } from './demo/demos'
import { getExperienceHref } from './config/entryPoints'
import { AcceptableUsePage } from './components/AcceptableUsePage'
import { TermsPage } from './components/TermsPage'
import { PrivacyPage } from './components/PrivacyPage'
import { GuidedWalkthrough } from './components/GuidedWalkthrough'
import { FlowBackdrop } from './components/FlowBackdrop'
import { GettingStarted } from './components/GettingStarted'
import { ProductIntro } from './components/ProductIntro'

function scrollToDemos() {
  document.getElementById('mechanisms')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

export default function App() {
  const embedded = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('embed') === '1'
  const [hash, setHash] = useState(() => typeof window === 'undefined' ? '' : window.location.hash)
  useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    if (isManualHash(hash) || hash === '#privacy' || hash === '#terms' || hash === '#acceptable-use') window.scrollTo(0, 0)
    else if (hash) document.getElementById(hash.slice(1))?.scrollIntoView()
  }, [hash])
  const [openDemo, setOpenDemo] = useState<DemoDef | null>(null)
  const experienceHref = getExperienceHref(typeof window === 'undefined' ? '' : window.location.pathname)

  return (
    <>
      {!embedded && <Nav />}
      {isManualHash(hash) ? <ManualPage chapterId={getManualChapterId(hash)} embedded={embedded} /> : hash === '#privacy' ? <PrivacyPage /> : hash === '#terms' ? <TermsPage /> : hash === '#acceptable-use' ? <AcceptableUsePage /> : <main className="landing-home">
        <FlowBackdrop />
        <Hero onOpenDemos={scrollToDemos} experienceHref={experienceHref} />
        <ProductIntro />
        <Features />
        <Demos onOpen={setOpenDemo} />
        <Compare />
        <Workflow />
        <Channels />
        <RemoteShare />
        <EnginesStrip />
        <div className="container recorded-section"><GuidedWalkthrough><FinalCta experienceHref={experienceHref} /></GuidedWalkthrough></div>
        <GettingStarted />
      </main>}
      {!embedded && <Footer />}
      {openDemo && <DemoModal demo={openDemo} onClose={() => setOpenDemo(null)} />}
    </>
  )
}
