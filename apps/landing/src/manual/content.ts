import { onboardingChapters } from './onboarding'
import { featureChapters } from './features'
export interface ManualScreenshot { id: string; alt: string; caption: string }
export interface ManualSection { title: string; steps: string[]; tips?: string[]; screenshot?: ManualScreenshot }
export interface ManualChapter { id: string; title: string; summary: string; sections: ManualSection[] }
export const manualChapters: ManualChapter[] = [...onboardingChapters, ...featureChapters]
export function isManualHash(hash: string) { return hash === '#docs' || hash.startsWith('#docs/') }
export function getManualChapterId(hash: string) {
  const id = hash.slice('#docs/'.length)
  return manualChapters.find(c => c.id === id)?.id ?? manualChapters[0].id
}
export const screenshotAssets = import.meta.glob('./screenshots/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
export function screenshotUrl(id: string) { return screenshotAssets[`./screenshots/${id}.jpg`] }
