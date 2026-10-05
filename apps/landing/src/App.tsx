import { useState } from 'react'
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
import { Philosophy } from './components/Philosophy'
import { RemoteShare } from './components/RemoteShare'
import { Workflow } from './components/Workflow'
import type { DemoDef } from './demo/demos'
import { getExperienceHref } from './config/entryPoints'

function scrollToDemos() {
  document.getElementById('demos')?.scrollIntoView({ behavior: 'smooth' })
}

export default function App() {
  const [openDemo, setOpenDemo] = useState<DemoDef | null>(null)
  const experienceHref = getExperienceHref(typeof window === 'undefined' ? '' : window.location.pathname)

  return (
    <>
      <Nav />
      <main>
        <Hero onOpenDemos={scrollToDemos} experienceHref={experienceHref} />
        <EnginesStrip />
        <Philosophy />
        <Features />
        <Compare />
        <Demos onOpen={setOpenDemo} />
        <Workflow />
        <Channels />
        <RemoteShare />
        <FinalCta experienceHref={experienceHref} />
      </main>
      <Footer />
      {openDemo && <DemoModal demo={openDemo} onClose={() => setOpenDemo(null)} />}
    </>
  )
}
