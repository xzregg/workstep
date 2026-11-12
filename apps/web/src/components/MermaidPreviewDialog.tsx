import ImagePreview from './ImagePreview'
import { useI18n } from '../i18n'

interface MermaidPreviewDialogProps {
  svg: string
  onClose: () => void
}

export default function MermaidPreviewDialog({ svg, onClose }: MermaidPreviewDialogProps) {
  const { t } = useI18n()
  const document = new window.DOMParser().parseFromString(svg, 'image/svg+xml')
  document.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const source = new window.XMLSerializer().serializeToString(document.documentElement)
  return <ImagePreview src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`} diagramSvg={source} alt={t('md.mermaidPreview')} onClose={onClose} />
}
