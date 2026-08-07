import type { CSSProperties, ReactNode } from 'react'
import {
  Archive, Book, Bookmark, Check, ChevronDown, ChevronRight, Copy, Ellipsis,
  ExternalLink, Folder, Image as ImageIcon, Layers, LayoutGrid, List,
  Pencil, Plus, RefreshCw, RotateCcw, Settings, SlidersHorizontal,
  Sparkles, Table, Trash2, Undo2, X,
} from 'lucide-react'

/** 统一 Icon 库：lucide 图标 + 少量自定义字形（保留既有固定规格） */
const glyphs = {
  archive: Archive,
  book: Book,
  bookmark: Bookmark,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  copy: Copy,
  ellipsis: Ellipsis,
  'external-link': ExternalLink,
  folder: Folder,
  image: ImageIcon,
  layers: Layers,
  'layout-grid': LayoutGrid,
  list: List,
  pencil: Pencil,
  plus: Plus,
  refresh: RefreshCw,
  'rotate-ccw': RotateCcw,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  table: Table,
  trash: Trash2,
  'undo-2': Undo2,
  x: X,
} as const

/** 自定义字形（viewBox 0 0 24 24），fill 字形用 `fill` prop 开启 */
const customGlyphs: Record<string, { viewBox: string; node: ReactNode }> = {
  send: {
    viewBox: '0 0 24 24',
    node: (
      <>
        <path d="M22 2 11 13" />
        <path d="m22 2-7 20-4-9-9-4z" />
      </>
    ),
  },
  stop: {
    viewBox: '0 0 24 24',
    node: <rect x="5" y="5" width="14" height="14" rx="2" />,
  },
  'resize-corner': {
    viewBox: '0 0 11 11',
    node: <path d="M10.5 0.5v10h-10" />,
  },
}

export type IconName = keyof typeof glyphs | keyof typeof customGlyphs

interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  color?: string
  fill?: boolean
  className?: string
  style?: CSSProperties
}

export default function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  color = 'currentColor',
  fill = false,
  className,
  style,
}: IconProps) {
  if (name in customGlyphs) {
    const { viewBox, node } = customGlyphs[name]
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill={fill ? color : 'none'}
        stroke={fill ? 'none' : color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className}
        style={style}
      >
        {node}
      </svg>
    )
  }
  const Glyph = glyphs[name as keyof typeof glyphs]
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={strokeWidth}
      color={color}
      fill={fill ? 'currentColor' : 'none'}
      aria-hidden="true"
      className={className}
      style={style}
    />
  )
}
