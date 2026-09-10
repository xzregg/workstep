import type { CSSProperties, ReactNode } from 'react'
import {
  Archive, BarChart3, Book, Bookmark, Bot, Check, ChevronDown, ChevronRight, Clock, Copy, Download, Ellipsis, Eye,
  ExternalLink, FileText, Folder, FolderOpen, GitFork, GripVertical, Image as ImageIcon, Layers, LayoutGrid, List,
  Menu, Lightbulb, Paperclip, Pencil, Plus, RefreshCw, RotateCcw, Settings, Share2, SlidersHorizontal,
  Radio, Search, ShieldCheck, Sparkles, Table, Terminal, Trash2, Undo2, Workflow, X,
} from 'lucide-react'

/** 统一 Icon 库：lucide 图标 + 少量自定义字形（保留既有固定规格） */
const glyphs = {
  menu: Menu,
  archive: Archive,
  'bar-chart': BarChart3,
  book: Book,
  bookmark: Bookmark,
  bot: Bot,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  clock: Clock,
  copy: Copy,
  download: Download,
  ellipsis: Ellipsis,
  eye: Eye,
  'external-link': ExternalLink,
  file: FileText,
  folder: Folder,
  'folder-open': FolderOpen,
  'git-fork': GitFork,
  'grip-vertical': GripVertical,
  image: ImageIcon,
  layers: Layers,
  'layout-grid': LayoutGrid,
  lightbulb: Lightbulb,
  list: List,
  paperclip: Paperclip,
  pencil: Pencil,
  plus: Plus,
  refresh: RefreshCw,
  radio: Radio,
  'rotate-ccw': RotateCcw,
  search: Search,
  settings: Settings,
  share: Share2,
  shield: ShieldCheck,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  table: Table,
  terminal: Terminal,
  trash: Trash2,
  'undo-2': Undo2,
  workflow: Workflow,
  x: X,
} as const

/** 自定义字形（viewBox 0 0 24 24），fill 字形用 `fill` prop 开启 */
const customGlyphs = {
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
} satisfies Record<string, { viewBox: string; node: ReactNode }>

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
    const { viewBox, node } = customGlyphs[name as keyof typeof customGlyphs]
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
