/** Shared fixed geometry for the live Icon and isolated HTML preview. */
export const composerSendGlyphs = {
 send: ['M22 2 11 13', 'm22 2-7 20-4-9-9-4z'],
 'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
 'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
} as const
export function composerSendMarkup(name: keyof typeof composerSendGlyphs = 'send') {
 const paths=composerSendGlyphs[name]
 return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(path=>`<path d="${path}"/>`).join('')}</svg>`
}
