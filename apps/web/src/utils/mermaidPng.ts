type PngConverter = (svg: string) => Promise<Blob>

function readSvgSize(svg: string) {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = document.documentElement
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number)
  const width = viewBox?.length === 4 && Number.isFinite(viewBox[2])
    ? viewBox[2]
    : Number.parseFloat(root.getAttribute('width') ?? '') || 1200
  const height = viewBox?.length === 4 && Number.isFinite(viewBox[3])
    ? viewBox[3]
    : Number.parseFloat(root.getAttribute('height') ?? '') || 800
  const scale = Math.min(2, 4096 / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function svgToPng(svg: string): Promise<Blob> {
  const source = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(source)
  try {
    const image = new Image()
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to decode Mermaid SVG'))
    })
    image.src = url
    await loaded

    const size = readSvgSize(svg)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(image, 0, 0, size.width, size.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Unable to encode Mermaid PNG')),
        'image/png',
      )
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

let pngConverter: PngConverter = svgToPng

export async function copyMermaidPng(svg: string) {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('Image clipboard is unavailable')
  }
  // Construct ClipboardItem before awaiting conversion so browsers that require
  // a user activation keep the copy operation associated with the click.
  const item = new ClipboardItem({ 'image/png': pngConverter(svg) })
  await navigator.clipboard.write([item])
}

export function setMermaidPngConverterForTests(converter: PngConverter) {
  pngConverter = converter
}

export function resetMermaidPngConverterForTests() {
  pngConverter = svgToPng
}
