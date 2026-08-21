import { useState } from 'react'
import { Demos } from './components/Demos'
import { DemoModal } from './components/DemoModal'
import { EnginesStrip } from './components/EnginesStrip'
import { Features } from './components/Features'
import { Footer } from './components/Footer'
import { Hero } from './components/Hero'
import { Nav } from './components/Nav'
import { RemoteShare } from './components/RemoteShare'
import { Workflow } from './components/Workflow'
import type { DemoDef } from './demo/demos'

function scrollToDemos() {
  document.getElementById('demos')?.scrollIntoView({ behavior: 'smooth' })
}

export default function App() {
  const [openDemo, setOpenDemo] = useState<DemoDef | null>(null)

  return (
    <>
      <Nav />
      <main>
        <Hero onOpenDemos={scrollToDemos} />
        <EnginesStrip />
        <Features />
        <RemoteShare />
        <Demos onOpen={setOpenDemo} />
        <Workflow />
      </main>
      <Footer />
      {openDemo && <DemoModal demo={openDemo} onClose={() => setOpenDemo(null)} />}
    </>
  )
}
