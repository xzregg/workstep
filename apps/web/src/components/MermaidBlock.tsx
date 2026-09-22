/* oxlint-disable react/only-export-components -- test loader hooks share module-level caches with the component. */
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useI18n } from '../i18n'
import {
  copyMermaidPng,
  resetMermaidPngConverterForTests,
  setMermaidPngConverterForTests,
} from '../utils/mermaidPng'
import Icon from './Icon'
import MermaidPreviewDialog from './MermaidPreviewDialog'

type MermaidTheme = 'default' | 'dark'

interface MermaidApi {
  initialize: (config: {
    startOnLoad: boolean
    securityLevel: 'strict'
    suppressErrorRendering: boolean
    theme: MermaidTheme
  }) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}

type MermaidModule = MermaidApi | { default: MermaidApi }
type MermaidLoader = () => Promise<MermaidModule>

const STABILITY_DELAY_MS = 300
const LOAD_RETRY_DELAY_MS = 200
const SVG_CACHE_LIMIT = 50

export const MarkdownStreamingContext = createContext(false)

let loader: MermaidLoader = () => import('mermaid')
let modulePromise: Promise<MermaidApi> | null = null
let renderSequence = 0
const svgCache = new Map<string, string>()
const pendingRenders = new Map<string, Promise<string>>()

function normalizeModule(module: MermaidModule): MermaidApi {
  return 'default' in module ? module.default : module
}

function readCachedSvg(key: string): string | undefined {
  const svg = svgCache.get(key)
  if (svg === undefined) return undefined
  svgCache.delete(key)
  svgCache.set(key, svg)
  return svg
}

function cacheSvg(key: string, svg: string) {
  svgCache.set(key, svg)
  if (svgCache.size > SVG_CACHE_LIMIT) {
    const oldestKey = svgCache.keys().next().value
    if (oldestKey !== undefined) svgCache.delete(oldestKey)
  }
}

function loadMermaid(): Promise<MermaidApi> {
  if (modulePromise) return modulePromise
  modulePromise = (async () => {
    try {
      return normalizeModule(await loader())
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, LOAD_RETRY_DELAY_MS))
      return normalizeModule(await loader())
    }
  })().catch((error) => {
    modulePromise = null
    throw error
  })
  return modulePromise
}

async function renderDiagram(code: string, theme: MermaidTheme): Promise<string> {
  const key = `${theme}\u0000${code}`
  const cached = readCachedSvg(key)
  if (cached !== undefined) return cached

  const pending = pendingRenders.get(key)
  if (pending) return pending

  const rendering = (async () => {
    const mermaid = await loadMermaid()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
    })
    const result = await mermaid.render(`workstep-mermaid-${++renderSequence}`, code)
    cacheSvg(key, result.svg)
    return result.svg
  })()
  pendingRenders.set(key, rendering)
  try {
    return await rendering
  } finally {
    pendingRenders.delete(key)
  }
}

function currentTheme(): MermaidTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'default'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'
}

function MermaidSource({ code }: { code: string }) {
  return (
    <pre className="mermaid-block__source">
      <code className="language-mermaid">{code}</code>
    </pre>
  )
}

function MermaidBlock({ code }: { code: string }) {
  const streaming = useContext(MarkdownStreamingContext)
  const { t } = useI18n()
  const [theme, setTheme] = useState<MermaidTheme>(currentTheme)
  const [state, setState] = useState<{ key: string; svg?: string; failed?: boolean }>({ key: '' })
  const [previewOpen, setPreviewOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const generation = useRef(0)
  const copyResetTimer = useRef<number | null>(null)
  const renderKey = `${theme}\u0000${code}`

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => setTheme(media.matches ? 'dark' : 'default')
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    const activeGeneration = ++generation.current
    if (streaming) return

    const timer = window.setTimeout(() => {
      void renderDiagram(code, theme).then(
        (svg) => {
          if (generation.current === activeGeneration) setState({ key: renderKey, svg })
        },
        () => {
          if (generation.current === activeGeneration) setState({ key: renderKey, failed: true })
        },
      )
    }, STABILITY_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [code, renderKey, streaming, theme])

  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
  }, [])

  if (streaming || state.key !== renderKey || (!state.svg && !state.failed)) {
    return <MermaidSource code={code} />
  }
  if (state.failed) {
    return (
      <div className="mermaid-block mermaid-block--error">
        <MermaidSource code={code} />
        <div className="mermaid-block__error" role="status">{t('md.mermaidError')}</div>
      </div>
    )
  }
  const svg = state.svg ?? ''
  const copyTitle = copyState === 'copied'
    ? t('md.mermaidCopied')
    : copyState === 'failed' ? t('md.mermaidCopyFailed') : t('md.mermaidCopy')
  const copyDiagram = async () => {
    try {
      await copyMermaidPng(svg)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => setCopyState('idle'), 1800)
  }

  return (
    <>
      <div className="mermaid-block mermaid-block__diagram">
        <button
          type="button"
          className="mermaid-block__preview-trigger"
          aria-label={t('md.mermaidPreview')}
          title={t('md.mermaidPreview')}
          onClick={() => setPreviewOpen(true)}
        >
          <span dangerouslySetInnerHTML={{ __html: svg }} />
        </button>
        <button
          type="button"
          className="chat-message-action mermaid-block__copy"
          data-copy-state={copyState}
          aria-label={copyTitle}
          title={copyTitle}
          onClick={() => void copyDiagram()}
        >
          <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={14} />
        </button>
      </div>
      {previewOpen && <MermaidPreviewDialog svg={svg} onClose={() => setPreviewOpen(false)} />}
    </>
  )
}

export function setMermaidLoader(nextLoader: MermaidLoader) {
  loader = nextLoader
  modulePromise = null
}

export function resetMermaidForTests() {
  loader = () => import('mermaid')
  modulePromise = null
  renderSequence = 0
  svgCache.clear()
  pendingRenders.clear()
  resetMermaidPngConverterForTests()
}

export const setMermaidPngConverter = setMermaidPngConverterForTests

export default memo(MermaidBlock)
