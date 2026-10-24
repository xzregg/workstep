import { onboardingChapters } from './onboarding'
import { featureChapters } from './features'
import { translate, type Lang } from '../i18n'
import enUS from './locales/en-US.json'
import frFR from './locales/fr-FR.json'
import deDE from './locales/de-DE.json'
import ar from './locales/ar.json'
export interface ManualScreenshot { id: string; alt: string; caption: string }
export interface ManualSection { title: string; steps: string[]; tips?: string[]; screenshot?: ManualScreenshot }
export interface ManualChapter { id: string; title: string; summary: string; sections: ManualSection[] }
export const manualChapters: ManualChapter[] = [...onboardingChapters, ...featureChapters]
const localizedChapters: Record<Lang, ManualChapter[]> = { 'zh-CN': manualChapters, 'en-US': enUS, 'fr-FR': frFR, 'de-DE': deDE, ar }
export function getManualChapters(lang: Lang = 'zh-CN') { return localizedChapters[lang] }
export const manualGroups = [
  { id: 'getting-started', title: '快速入门', chapterIds: onboardingChapters.map(chapter => chapter.id) },
  { id: 'automation', title: '流程与自动化', chapterIds: ['workflow', 'templates-ai-flow', 'workflow-hooks', 'quick-actions', 'schedules'] },
  { id: 'delivery', title: '任务与交付', chapterIds: ['tasks', 'execution', 'results', 'git'] },
  { id: 'personalization', title: '对话与个性化', chapterIds: ['chat-skills', 'appearance'] },
  { id: 'collaboration', title: '共享与协作', chapterIds: ['sharing-remote', 'gateway-workspace', 'bots', 'project-audit'] },
  { id: 'help', title: '设置与帮助', chapterIds: ['sandbox', 'settings-troubleshooting', 'faq'] },
]
export function getManualGroups(query = '', lang: Lang = 'zh-CN') {
  const normalized = query.trim().toLocaleLowerCase(lang)
  const chapters = getManualChapters(lang)
  return manualGroups.map(group => ({
    ...group,
    title: translate(lang, `manual.groups.${group.id}`),
    chapters: group.chapterIds.flatMap(id => {
      const chapter = chapters.find(chapter => chapter.id === id)
      return chapter && (!normalized || JSON.stringify(chapter).toLocaleLowerCase(lang).includes(normalized) || translate(lang, `manual.groups.${group.id}`).toLocaleLowerCase(lang).includes(normalized)) ? [chapter] : []
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
