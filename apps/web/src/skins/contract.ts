import source from '../../../daemon/data/skins/contract.json' with { type: 'json' }
import {validateComposerSendGlyph, type ComposerSendGlyph} from './composerSendGlyphs'

export const skinContract = source as {
  schema_version: number; breakpoint: number; tokens: Record<string, string>;
  parts: Record<string, string>; states: Record<string, string>; properties: Record<string, string>;
  layout: Record<string, { default: string | number; values?: string[]; min?: number; max?: number }>;
  actions: Record<string, string[]>; token_kinds: Record<string, string>; value_patterns: Record<string, string>;
  components: Record<string, { parts: string[]; states: string[]; actions: string[]; required: string[]; layouts?: string[]; presentations?: string[] }>;
}
export type SkinStyles = Record<string, Record<string, Record<string, string>>>
export interface SkinLayout {
  composerSendIcon?: ComposerSendGlyph;
  fontSize?: 'inherit' | 'small' | 'standard' | 'large' | 'extraLarge';
  sidebarSide?: 'left' | 'right'; sidebarWidth?: number; contentWidth?: number;
  density?: 'standard' | 'compact' | 'comfortable'; stepsSide?: 'left' | 'right';
  stepsRatio?: number; splitHandleWidth?: number; composerToolsPosition?: 'top' | 'bottom';
  engineAppearance?: 'list' | 'cards'; backgroundGlow?: 'none' | 'accent';
}
export interface SkinDocument {
  manifest: { id: string; name: string; version: string; schema_version: number; color_scheme: 'light' | 'dark'; description?: string };
  tokens: Record<string, string>; styles: SkinStyles; layout: SkinLayout;
  desktop?: { tokens?: Record<string, string>; styles?: SkinStyles; layout?: SkinLayout };
  mobile?: { tokens?: Record<string, string>; styles?: SkinStyles; layout?: SkinLayout };
  revision: string; asset_base: string;
  coverage?: { overridden: string[]; inherited: string[] };
}

export function defaultSkin(): SkinDocument {
  return { manifest: { id: 'default', name: '默认皮肤', version: '1', schema_version: 1, color_scheme: 'light' }, tokens: {}, styles: {}, layout: {}, revision: 'default', asset_base: '' }
}

const badCss = /[;{}<>@!\\]|url\s*\(|expression\s*\(|(?:https?|data|javascript):/i
export function validateCssValue(value: string, kind = 'value') {
  if (typeof value !== 'string' || !value || value.length > 512 || badCss.test(value) || [...value].some(char => char.charCodeAt(0) < 32)) throw new Error('样式值无效或包含不允许的内容')
  if (skinContract.value_patterns[kind] && !new RegExp('^(?:' + skinContract.value_patterns[kind] + ')$').test(value)) throw new Error('样式值不符合属性类型')
  if (kind === 'asset' && !/^assets\/[A-Za-z0-9_./-]+\.(png|jpe?g|webp)$/i.test(value)) throw new Error('背景图必须引用 assets 内的本地图片')
  if (kind === 'asset' && value.split('/').includes('..')) throw new Error('背景资源路径无效')
  if (kind === 'length') {
    if (!/^(?:0|(?:\d+(?:\.\d+)?)(?:px|rem|em|%)|var\(--[a-z][a-z0-9-]*\))(?: (?:0|\d+(?:\.\d+)?(?:px|rem|em|%))){0,3}$/.test(value)) throw new Error('组件尺寸无效')
    if ([...value.matchAll(/(\d+(?:\.\d+)?)px/g)].some(m => Number(m[1]) > 256)) throw new Error('组件尺寸超出范围')
  }
  if (kind === 'weight' && !/^(normal|bold|[1-9]00)$/.test(value)) throw new Error('字体粗细无效')
  if (kind === 'background-repeat' && !['repeat', 'no-repeat', 'repeat-x', 'repeat-y'].includes(value)) throw new Error('背景重复方式无效')
}

const cssProperty = (name: string) => name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())
export function compileSkin(skin: SkinDocument): string {
  if (!skin || skin.manifest?.schema_version !== 1 || !/^[a-z][a-z0-9_-]{0,63}$/.test(skin.manifest.id) || !['light', 'dark'].includes(skin.manifest.color_scheme)) throw new Error('皮肤清单无效')
  const scope = `html[data-skin-id="${skin.manifest.id}"]`
  const tokens = (values: Record<string, string> = {}) => Object.entries(values).map(([name, value]) => {
    if (!Object.hasOwn(skinContract.tokens, name)) throw new Error('未知或受保护的样式变量')
    validateCssValue(value, skinContract.token_kinds[name])
    return `--${name}:${value} !important;`
  }).join('')
  const rules = (styles: SkinStyles = {}) => Object.entries(styles).flatMap(([part, states]) => {
    if (!Object.hasOwn(skinContract.parts, part)) throw new Error('未知组件部位')
    return Object.entries(states).map(([state, properties]) => {
      if (!Object.hasOwn(skinContract.states, state)) throw new Error('未知组件状态')
      const declarations = Object.entries(properties).map(([name, value]) => {
        if (!Object.hasOwn(skinContract.properties, name)) throw new Error('未知或受保护的样式属性')
        if (/(handle|resize)/.test(part) && ['padding', 'paddingInline', 'paddingBlock', 'borderWidth'].includes(name)) throw new Error('拖动部位尺寸由布局配置控制')
        validateCssValue(value, skinContract.properties[name])
        if (name === 'backgroundImage') {
          if (!/^\/[A-Za-z0-9_./%-]*api\/skins\/assets\/[a-zA-Z0-9]+(?:\?project_id=[A-Za-z0-9_%.-]+)?$/.test(skin.asset_base)) throw new Error('背景资源地址无效')
          const [base, query] = skin.asset_base.split('?')
          value = `url("${base}/${value.slice(7)}${query ? '?' + query : ''}")`
        }
        return `${cssProperty(name)}:${value} !important;`
      }).join('')
      const selectors = skinContract.parts[part].split(',').map(selector => {
        const pseudo = selector.trim().match(/^(.*?)(::[a-z-]+)$/)
        const target = pseudo ? pseudo[1] : selector.trim()
        return `${scope} ${target}${skinContract.states[state]}:not([data-skin-recovery]):not([data-skin-recovery] *)${pseudo?.[2] || ''}`
      })
      return `${selectors.join(',')}{${declarations}}`
    })
  }).join('\n')
  for (const layout of [skin.layout, skin.desktop?.layout || {}, skin.mobile?.layout || {}]) {
    for (const [name, value] of Object.entries(layout)) {
      if (name === 'composerSendIcon') { validateComposerSendGlyph(value); continue }
      const spec = Object.hasOwn(skinContract.layout, name) ? skinContract.layout[name] : undefined
      if (!spec || (spec.values ? !spec.values.includes(String(value)) : typeof value !== 'number' || !Number.isFinite(value) || value < spec.min! || value > spec.max!)) throw new Error('布局配置无效')
    }
  }
  return `${scope}{${tokens(skin.tokens)}}\n${rules(skin.styles)}\n` +
    `@media (min-width: 1024px){${scope}{${tokens(skin.desktop?.tokens)}}${rules(skin.desktop?.styles)}}\n` +
    `@media (max-width: 1023px){${scope}{${tokens(skin.mobile?.tokens)}}${rules(skin.mobile?.styles)}}`
}

export function resolvedSkinLayout(skin: SkinDocument, compact = false): Required<SkinLayout> {
  return { ...Object.fromEntries(Object.entries(skinContract.layout).map(([key, value]) => [key, value.default])), ...skin.layout, ...(compact ? skin.mobile?.layout : skin.desktop?.layout) } as Required<SkinLayout>
}


export function effectiveSkinTokens(skin: SkinDocument, compact = false): Record<string, string> {
  return { ...skinContract.tokens, ...skin.tokens, ...(compact ? skin.mobile?.tokens : skin.desktop?.tokens) }
}


/** Convert modern CSS colors to the RGB forms accepted by third-party renderers. */
export function skinColor(tokens: Record<string, string>, name: string): string {
  let value = tokens[name] || skinContract.tokens[name]
  for (let index = 0; index < 8 && value.includes('var('); index++) {
    value = value.replace(/var\(--([a-z0-9-]+)\)/g, (match, key: string) => tokens[key] || match)
  }
  if (/^(#[0-9a-f]+|rgba?\(|hsla?\()/i.test(value)) return value
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = '#012345'; context.fillStyle = value
      if (context.fillStyle !== '#012345') {
        context.fillRect(0, 0, 1, 1)
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
        return `rgba(${red},${green},${blue},${alpha / 255})`
      }
    }
  } catch { /* Headless component tests need no canvas renderer. */ }
  return skinContract.tokens[name]
}
