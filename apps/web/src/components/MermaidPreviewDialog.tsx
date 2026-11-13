import ImagePreview from './ImagePreview'
import { useI18n } from '../i18n'

interface MermaidPreviewDialogProps {
  svg: string
  onClose: () => void
}

export default function MermaidPreviewDialog({ svg, onClose }: MermaidPreviewDialogProps) {
  const { t } = useI18n()
  const document = new window.DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = document.documentElement
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  // Mermaid's percentage width has no intrinsic size when loaded as an image.
  // Give mobile image previews the same dimensions as the SVG's own canvas.
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    root.setAttribute('width', String(viewBox[2]))
    root.setAttribute('height', String(viewBox[3]))
  }
  const source = new window.XMLSerializer().serializeToString(document.documentElement)
  return <ImagePreview src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`} diagramSvg={source} alt={t('md.mermaidPreview')} onClose={onClose} />
}
