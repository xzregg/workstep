import { describe, expect, it } from 'vitest'
import { supportedLanguages } from '../src/i18n'
import { getManualChapters, getManualGroups, manualChapters } from '../src/manual/content'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

function proseStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(proseStrings)
  return value && typeof value === 'object' ? Object.entries(value).filter(([key]) => key !== 'id').flatMap(([, item]) => proseStrings(item)) : []
}

describe('builtin language selection', () => {
  for (const lang of supportedLanguages.map(item => item.locale)) {
    it(`documents native calendar entry and host limits in ${lang}`, () => {
      const section = getManualChapters(lang).find(chapter => chapter.id === 'digital-person')!
        .sections.find(section => section.screenshot?.id === 'native-calendar')
      expect(section).toBeDefined()
      for (const term of ['Markdown', 'WorkStep', 'macOS', 'Android']) expect(section!.steps.join(' ')).toContain(term)
    })
  }
  for (const lang of supportedLanguages.map(item => item.locale)) {
    it(`documents current delegation, atlas and batched speech controls in ${lang}`, () => {
      const chapter = getManualChapters(lang).find(chapter => chapter.id === 'digital-person')!
      const text = chapter.sections.flatMap(section => [...section.steps, ...section.tips ?? []]).join(' ')
      expect(text).toContain('60')
      expect(text).toContain('500')
      expect(text).toContain('350')
    })
  }
  for (const lang of supportedLanguages.map(item => item.locale)) {
    it(`documents prototype editing and its screenshot in ${lang}`, () => {
      const section = getManualChapters(lang).find(chapter => chapter.id === 'results')!.sections.find(section => section.screenshot?.id === 'prototype-editor')!
      expect(section).toBeDefined()
      expect(section.steps).toHaveLength(5)
      expect(section.steps.join(' ')).toContain('180px')
      expect(section.tips?.join(' ')).toContain('HTML/CSS/JS')
    })

    it(`documents click-to-install desktop updates and platform limits in ${lang}`, () => {
      const section = getManualChapters(lang).find(chapter => chapter.id === 'settings-troubleshooting')!
        .sections.find(section => section.screenshot?.id === 'desktop-update')!
      expect(section.steps).toHaveLength(3)
      expect(section.tips?.join(' ')).toContain('AppImage')
      expect(section.tips?.join(' ')).toContain('macOS')
      expect(section.steps[2]).toContain('GitHub')
    })
  }
  for (const lang of supportedLanguages.map(item => item.locale)) {
    it(`documents the desktop conversation workspace in ${lang}`, () => {
      const chapter = getManualChapters(lang).find(chapter => chapter.id === 'chat-skills')!
      const section = chapter.sections.find(section => section.screenshot?.id === 'chat-workspace')!
      expect(section).toBeDefined()
      expect(section.steps.length).toBeGreaterThanOrEqual(4)
      expect(section.steps.join(' ')).toContain('4')
      expect(section.tips?.length).toBeGreaterThanOrEqual(2)
    })
  }
  for (const lang of supportedLanguages.map(item => item.locale)) {
    it(`documents QQ setup and OpenID binding in ${lang}`, () => {
      const chapter = getManualChapters(lang).find(chapter => chapter.id === 'bots')!
      expect(chapter.summary).toContain('QQ')
      const section = chapter.sections.find(section => section.screenshot?.id === 'bot-channels')!
      const setup = section.steps.find(step => step.includes('QQ'))!
      expect(setup).toContain('App ID')
      expect(setup).toContain('App Secret')
      expect(setup).toContain('group_openid')
      expect(section.tips?.join(' ')).toContain('QQ')
    })
  }
  it('explains the current skin script switch, preview boundary and reusable creation session', () => {
    const appearance = manualChapters.find(chapter => chapter.id === 'appearance')!
    const extensions = appearance.sections.find(section => section.screenshot?.id === 'skin-v2-extensions')!
    expect(extensions.steps.join(' ')).toContain('运行皮肤脚本')
    expect(extensions.steps.join(' ')).toContain('缩略图不执行脚本')
    expect(extensions.steps.join(' ')).toContain('临时改变整个工作台')
    expect(extensions.steps.join(' ')).toContain('部分菜单可能保留为不可用')
    expect(extensions.steps.join(' ')).not.toContain('重新确认')
    expect(appearance.sections.find(section => section.screenshot?.id === 'appearance-studio')!.tips?.join(' ')).toContain('重新打开制作入口')
    expect(manualChapters.find(chapter => chapter.id === 'chat-skills')!.sections[0].tips?.join(' ')).not.toContain('刷新浏览器不保证恢复')
    const chat = manualChapters.find(chapter => chapter.id === 'chat-skills')!
    expect(chat.sections.find(section => section.screenshot?.id === 'project-chat')!.tips?.join(' ')).toContain('超快')
    expect(chat.sections.find(section => section.screenshot?.id === 'project-skills')!.steps.join(' ')).toContain('流程模式')
  })
  it('requires a translation review when the Chinese manual changes', () => {
    const fingerprint = readFileSync(new URL('../src/manual/locales/source.sha256', import.meta.url), 'utf8').trim()
    expect(createHash('sha256').update(JSON.stringify(manualChapters)).digest('hex')).toBe(fingerprint)
  })
  for (const lang of supportedLanguages.map(item => item.locale).filter(lang => lang !== 'zh-CN')) {
    it(`provides complete ${lang} chapters and preserves links and screenshots`, () => {
      const chapters = getManualChapters(lang)
      if (lang !== 'en-US') {
        const english = proseStrings(getManualChapters('en-US'))
        proseStrings(chapters).forEach((text, i) => {
          expect(text, `${lang}: ${i}`).not.toBe(english[i])
        })
      }
      expect(chapters.map(chapter => chapter.id)).toEqual(manualChapters.map(chapter => chapter.id))
      for (const [index, chapter] of chapters.entries()) {
        const source = manualChapters[index]
        if (lang !== 'zh-TW') expect(chapter.title).not.toBe(source.title)
        if (lang !== 'zh-TW') expect(chapter.summary).not.toBe(source.summary)
        if (lang !== 'en-US') expect(chapter.summary).not.toBe(getManualChapters('en-US')[index].summary)
        expect(chapter.sections).toHaveLength(source.sections.length)
        chapter.sections.forEach((section, i) => {
          expect(section.steps).toHaveLength(source.sections[i].steps.length)
          expect(section.tips?.length).toBe(source.sections[i].tips?.length)
          expect(section.screenshot?.id).toBe(source.sections[i].screenshot?.id)
          for (const [j, text] of [...section.steps, ...section.tips ?? []].entries()) {
            const sourceText = [...source.sections[i].steps, ...source.sections[i].tips ?? []][j]
            for (const token of sourceText.match(/\{[a-zA-Z_][a-zA-Z_0-9]*\}|\b[a-z][a-z0-9]*(?:[._:][a-z0-9_]+)+\b|WORKSTEP_ACTION_INPUT|App ID|App Secret|OpenID/g) ?? []) expect(text).toContain(token)
          }
          if (lang !== 'zh-TW') expect(section.title).not.toBe(source.sections[i].title)
          if (lang !== 'zh-TW') section.steps.forEach((text, j) => expect(text).not.toBe(source.sections[i].steps[j]))
          if (lang !== 'zh-TW') section.tips?.forEach((text, j) => expect(text).not.toBe(source.sections[i].tips![j]))
          if (section.screenshot && lang !== 'zh-TW') {
            expect(section.screenshot.alt).not.toBe(source.sections[i].screenshot!.alt)
            expect(section.screenshot.caption).not.toBe(source.sections[i].screenshot!.caption)
          }
          for (const text of [...section.steps, ...section.tips ?? []]) expect(text.trim()).not.toBe('')
        })
      }
      const query = chapters[0].title
      expect(getManualGroups(query, lang).flatMap(group => group.chapters).map(chapter => chapter.id)).toContain(chapters[0].id)
      expect(getManualGroups('', lang)[0].title).toBeTruthy()
    })
  }
})
