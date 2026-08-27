import { useEffect, useRef, useState } from 'react'
import { Demos } from './components/Demos'
import { DemoModal } from './components/DemoModal'
import { DownloadModal } from './components/DownloadModal'
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

function scrollToDemos() {
  document.getElementById('demos')?.scrollIntoView({ behavior: 'smooth' })
}

export default function App() {
  const [openDemo, setOpenDemo] = useState<DemoDef | null>(null)
  const [downloadOpen, setDownloadOpen] = useState(false)
  const fallbackTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (fallbackTimer.current !== null) window.clearTimeout(fallbackTimer.current)
  }, [])

  const launchWithFallback = () => {
    if (fallbackTimer.current !== null) window.clearTimeout(fallbackTimer.current)
    fallbackTimer.current = window.setTimeout(() => {
      if (!document.hidden) setDownloadOpen(true)
    }, 1400)
  }

  return (
    <>
      <Nav />
      <main>
        <Hero onOpenDemos={scrollToDemos} onLaunchFallback={launchWithFallback} />
        <EnginesStrip />
        <Philosophy />
        <Features />
        <Demos onOpen={setOpenDemo} />
        <Workflow />
        <RemoteShare />
        <FinalCta />
      </main>
      <Footer />
      <button type="button" className="download-fallback-link" onClick={() => setDownloadOpen(true)}>
        下载 WorkStep
      </button>
      {openDemo && <DemoModal demo={openDemo} onClose={() => setOpenDemo(null)} />}
      {downloadOpen && <DownloadModal onClose={() => setDownloadOpen(false)} />}
    </>
  )
}
