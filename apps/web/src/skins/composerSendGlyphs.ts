/** Shared fixed geometry for the live Icon and isolated HTML preview. */
export const composerSendGlyphs = {
 send: ['M22 2 11 13', 'm22 2-7 20-4-9-9-4z'],
 'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
 'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
} as const
export type ComposerSendGlyph = keyof typeof composerSendGlyphs | {paths: string[]}
/** Declarative geometry only: no XML, attributes, URLs or executable content. */
export function validateComposerSendGlyph(value: unknown): asserts value is ComposerSendGlyph {
 if (typeof value === 'string' && Object.hasOwn(composerSendGlyphs, value)) return
 if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('paths' in value)) throw new Error('发送图标配置无效')
 const paths = value.paths
 if (!Array.isArray(paths) || paths.length < 1 || paths.length > 32 || paths.some(path => typeof path !== 'string' || path.length > 4096 || !/^[Mm]\s*[-+.0-9]/.test(path) || !/^[MmLlHhVvCcSsQqTtAaZz0-9., +\-]+$/.test(path))) throw new Error('发送图标路径无效')
}
export function composerSendMarkup(name: ComposerSendGlyph = 'send') {
 validateComposerSendGlyph(name)
 const paths=typeof name === 'string' ? composerSendGlyphs[name] : name.paths
 return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(path=>`<path d="${path}"/>`).join('')}</svg>`
}
