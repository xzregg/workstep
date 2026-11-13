import { useId, useState } from 'react'
import { Brain, Info, Layers, MessageCircle, MousePointer2, Zap } from 'lucide-react'
import { useI18n } from '../../i18n'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import { learnedMemory, memoryDemoNodes, type MemoryLayer, type MemoryNode } from './digitalPersonMemoryDemo'
import './DigitalPersonMemory.css'

const brainImage = new URL('../../assets/digital-person-memory-brain.png', import.meta.url).href
const layers = ['all', 'recent', 'current', 'long'] as const
type Layer = typeof layers[number]

export default function DigitalPersonMemory({ name, avatar }: { name: string; avatar: 'robot' | 'spark' }) {
  const { t } = useI18n()
  const uid = useId()
  const [nodes, setNodes] = useState<MemoryNode[]>(() => memoryDemoNodes.map(node => ({ ...node })))
  const [layer, setLayer] = useState<Layer>('all')
  const [loadedOnly, setLoadedOnly] = useState(false)
  const [selected, setSelected] = useState('self')
  const [candidate, setCandidate] = useState(false)
  const [status, setStatus] = useState('')
  const text = (key: keyof typeof import('../../i18n/locales/zh-CN').zhCN.digitalMemory) => t(`digitalMemory.${key}`)
  const layerName = (value: MemoryLayer) => text(value)
  const shown = nodes.filter(node => (layer === 'all' || node.layer === layer) && (!loadedOnly || node.loaded))
  const current = nodes.find(node => node.id === selected)
  const promoted = nodes.some(node => node.id === 'learned')
  const select = (id: string) => {
    if (id !== 'self' && !shown.some(node => node.id === id)) { setLayer('all'); setLoadedOnly(false) }
    setSelected(id)
  }
  const changeLayer = (value: Layer) => { setLayer(value); setSelected('self') }
  const changeMode = (loaded: boolean) => { setLoadedOnly(loaded); setLayer('all'); setSelected('self') }
  const night = () => {
    setLoadedOnly(false); setLayer('recent'); setSelected('episode'); setCandidate(!promoted)
    setStatus(text(promoted ? 'promoted' : 'nightStatus'))
  }
  const reset = () => {
    setNodes(memoryDemoNodes.map(node => ({ ...node }))); setLayer('all'); setLoadedOnly(false)
    setSelected('self'); setCandidate(false); setStatus(text('resetStatus'))
  }
  const confirm = () => {
    if (promoted) return
    setNodes(items => [...items, { ...learnedMemory }]); setCandidate(false)
    setLayer('all'); setLoadedOnly(false); setSelected('learned'); setStatus(text('savedStatus'))
  }
  const nodeLabel = (node: MemoryNode) => ({
    episode: text('hippocampus'), message: text('conversation'), tool: text('operation'),
    chat: text('conversationEnd'), watch: text('context'), notify: text('people'),
    check: text('projectFact'), preference: text('preference'), learned: text('newExperience'),
  })[node.id] || node.title
  const related = (ids: string[]) => ids.map(id => {
    const node = nodes.find(item => item.id === id)
    return node && <button type="button" className="digital-memory-related" key={id} onClick={() => select(id)}>{node.title}<span aria-hidden="true">→</span></button>
  })
  return <div className="digital-person-memory">
    <p className="digital-memory-preview">{text('preview')}</p>
    <div className="digital-person-memory-map">
      <div className="digital-memory-demo"><span>{text('demo')}</span><button type="button" onClick={reset}>{text('reset')}</button></div>
      <div className="digital-memory-filters">
        <div className="digital-memory-filter-group" role="group" aria-label={t('digitalPerson.memory')}>
          {layers.map(value => <button type="button" key={value} aria-pressed={layer === value} onClick={() => changeLayer(value)}>{text(value)}</button>)}
        </div><span>{t('digitalMemory.count', { count: shown.length })}</span>
      </div>
      <div className="digital-memory-brand"><strong className="digital-memory-brand-mark">W</strong><strong>WorkStep</strong><span>/ {t('digitalPerson.title')}</span></div>
      <div className="digital-memory-layout">
        <div className="digital-memory-visual">
          <div className="digital-memory-heading"><h2>{t('digitalMemory.title', { name })}</h2>
            <button type="button" className="digital-memory-person" onClick={() => select('self')} aria-label={text('profile')}><DigitalPersonAvatar avatar={avatar} /><strong>{name}</strong></button>
            <div className="digital-memory-modes" role="group" aria-label={text('panorama')}>
              <button type="button" aria-pressed={!loadedOnly} onClick={() => changeMode(false)}><Brain size={14} />{text('panorama')}</button>
              <button type="button" aria-pressed={loadedOnly} onClick={() => changeMode(true)}><Zap size={14} />{text('loaded')}</button>
              <button type="button" onClick={night}><Layers size={14} />{text('night')}</button>
            </div>
          </div>
          <div className="digital-memory-diagram" role="group" aria-label={t('digitalMemory.title', { name })}>
            <img className="digital-memory-brain" src={brainImage} alt="" />
            <div className="digital-memory-hemisphere digital-memory-hemisphere-left"><strong>{text('left')}</strong><span>{text('partition')}</span></div>
            <div className="digital-memory-hemisphere digital-memory-hemisphere-right"><strong>{text('right')}</strong><span>{text('partition')}</span></div>
            <svg className="digital-memory-routes" viewBox="0 0 1000 720" aria-hidden="true">
              <defs><marker id={`${uid}-gold`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#f0b83f" /></marker><marker id={`${uid}-teal`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#20c9c6" /></marker></defs>
              <path className="digital-memory-route-gold" d="M120 620Q270 630 340 470" markerEnd={`url(#${uid}-gold)`} />
              <path className="digital-memory-route-gold" d="M580 430Q570 210 730 175" markerEnd={`url(#${uid}-gold)`} />
              <path className="digital-memory-route-teal" d="M200 450Q240 635 420 650" markerEnd={`url(#${uid}-teal)`} />
              <path className="digital-memory-route-teal" d="M830 450Q810 635 590 650" markerEnd={`url(#${uid}-teal)`} />
              <path className="digital-memory-synapse" d="M245 190L335 220M200 295L260 320M185 445L215 465M815 235L775 260M820 330L770 355M815 455L750 475" />
            </svg>
            <span className="digital-memory-category digital-memory-category-facts">{text('facts')}</span>
            {!promoted && <span className="digital-memory-category digital-memory-category-methods">{text('methods')}</span>}
            <span className="digital-memory-category digital-memory-category-preferences">{text('preferences')}</span>
            <span className="digital-memory-hippo digital-memory-hippo-left"><strong>{text('hippocampus')}</strong><small>{text('temporary')}</small></span>
            <span className="digital-memory-hippo digital-memory-hippo-right"><strong>{text('hippocampus')}</strong><small>{text('temporary')}</small></span>
            <button type="button" className="digital-memory-archive" onClick={night}><Layers size={14} />{text('archive')}</button>
            {nodes.map(node => <button type="button" key={node.id} className={`digital-memory-node digital-memory-node-${node.id}`}
              data-layer={node.layer} data-muted={!shown.includes(node)} data-disabled={!!node.disabled && !loadedOnly}
              aria-pressed={selected === node.id} aria-label={nodeLabel(node)} hidden={!shown.includes(node)} onClick={() => select(node.id)}>
              {node.id === 'message' && <MessageCircle size={14} />}{node.id === 'tool' && <MousePointer2 size={14} />}
              {node.id === 'chat' && <MessageCircle size={16} />}{node.id === 'watch' && <Layers size={20} />}
              <span>{nodeLabel(node)}{node.id === 'watch' && <small>{text('recall')}</small>}</span>
            </button>)}
          </div>
          <div className="digital-memory-legend"><span>{text('gold')}</span><span>{text('purple')}</span><span>{text('teal')}</span></div>
          <p className="digital-memory-footnote"><Info size={14} />{text('metaphor')}</p>
        </div>
        <aside className="digital-memory-detail" aria-label={text('details')}>
          {current ? <>
            <div className="digital-memory-detail-tags"><span>{layerName(current.layer)}</span><span>{text(current.disabled ? 'disabled' : 'valid')}</span></div>
            <h3>{current.title}</h3><p>{current.reason}</p>
            <dl><dt>{text('scope')}</dt><dd>{current.scope}</dd><dt>{text('source')}</dt><dd>{current.source}</dd><dt>{text('loaded')}</dt><dd>{text(current.loaded ? 'snapshot' : 'notLoaded')}</dd></dl>
            <h4>{text('evidence')}</h4><blockquote>{current.quote}</blockquote><small>{text('excerpt')}</small>
            <h4>{text('related')}</h4>{related(current.related)}
            {current.id === 'episode' && <section><h4>{text('extractTitle')}</h4>
              {promoted ? <><p>{text('promoted')}</p>{related(['learned'])}</> : candidate ? <><span className="digital-memory-candidate">{text('candidate')}</span><p>{text('suggestion')}</p><div className="digital-memory-actions"><button type="button" onClick={confirm}>{text('confirm')}</button><button type="button" onClick={() => setCandidate(false)}>{text('cancel')}</button></div></> : <><p>{text('extractHint')}</p><button type="button" onClick={() => setCandidate(true)}>{text('extract')}</button></>}
            </section>}
            {current.layer === 'long' && <div className="digital-memory-actions"><button type="button" onClick={() => { setNodes(items => items.map(item => item.id === selected ? { ...item, disabled: !item.disabled } : item)); setStatus(text('disabledStatus')) }}>{text(current.disabled ? 'enable' : 'disable')}</button></div>}
            {current.loaded && <p className="digital-memory-notice">{text('snapshotHint')}</p>}
          </> : <><span className="digital-memory-profile-tag">{text('profile')}</span><h3>{t('digitalMemory.hello', { name })}</h3><p>{text('intro')}</p><h4>{text('try')}</h4>{related(['preference', 'watch', 'episode'])}<p className="digital-memory-notice">{text('excerpt')}</p></>}
        </aside>
      </div>
      <section className="digital-memory-node-list" aria-label={text('available')}><h3>{text('available')}</h3>
        {shown.map(node => <button type="button" key={node.id} aria-pressed={selected === node.id} onClick={() => select(node.id)}><span>{layerName(node.layer)}</span>{node.title}</button>)}
        {!shown.length && <p>{text('empty')}</p>}
      </section>
      <div className="digital-memory-status" role="status" aria-live="polite">{status}</div>
    </div>
  </div>
}
