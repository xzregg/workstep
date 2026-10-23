import { onboardingChapters } from './onboarding'
import { featureChapters } from './features'
export interface ManualScreenshot { id: string; alt: string; caption: string }
export interface ManualSection { title: string; steps: string[]; tips?: string[]; screenshot?: ManualScreenshot }
export interface ManualChapter { id: string; title: string; summary: string; sections: ManualSection[] }
export const manualChapters: ManualChapter[] = [...onboardingChapters, ...featureChapters]
export const manualGroups = [
  { id: 'getting-started', title: '快速入门', chapterIds: onboardingChapters.map(chapter => chapter.id) },
  { id: 'automation', title: '流程与自动化', chapterIds: ['workflow', 'templates-ai-flow', 'workflow-hooks', 'quick-actions', 'schedules'] },
  { id: 'delivery', title: '任务与交付', chapterIds: ['tasks', 'execution', 'results', 'git'] },
  { id: 'personalization', title: '对话与个性化', chapterIds: ['chat-skills', 'appearance'] },
  { id: 'collaboration', title: '共享与协作', chapterIds: ['sharing-remote', 'gateway-workspace', 'bots', 'project-audit'] },
  { id: 'help', title: '设置与帮助', chapterIds: ['sandbox', 'settings-troubleshooting', 'faq'] },
]
export function getManualGroups(query = '') {
  const normalized = query.trim().toLowerCase()
  return manualGroups.map(group => ({
    ...group,
    chapters: group.chapterIds.flatMap(id => {
      const chapter = manualChapters.find(chapter => chapter.id === id)
      return chapter && (!normalized || JSON.stringify(chapter).toLowerCase().includes(normalized)) ? [chapter] : []
    }),
  })).filter(group => group.chapters.length > 0)
}
export function isManualHash(hash: string) { return hash === '#docs' || hash.startsWith('#docs/') }
export function getManualChapterId(hash: string) {
  const id = hash.slice('#docs/'.length)
  return manualChapters.find(c => c.id === id)?.id ?? manualChapters[0].id
}
export const screenshotAssets = import.meta.glob('./screenshots/*.jpg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
export function screenshotUrl(id: string) { return screenshotAssets[`./screenshots/${id}.jpg`] }
