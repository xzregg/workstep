import { useState } from 'react'
import { useI18n, languageDirection } from '../i18n'
import { getManualChapters, manualGroups, getManualGroups, screenshotUrl } from './content'
import './manual.css'

function ManualDirectory({ chapterId, query }: { chapterId: string; query: string }) {
  const { t, lang } = useI18n()
  const [expandedGroup, setExpandedGroup] = useState(() => manualGroups.find(group => group.chapterIds.includes(chapterId))?.id)
  const groups = getManualGroups(query, lang)
  const searching = Boolean(query.trim())
  return <nav className="manual-groups" aria-label={t('manual.chapters')} lang={lang}>
    {groups.map(group => {
      const expanded = searching || expandedGroup === group.id
      const current = group.chapterIds.includes(chapterId)
      return <div className="manual-group" key={group.id}>
        <button className="manual-group-toggle" type="button" aria-expanded={expanded} aria-controls={`manual-group-${group.id}`} onClick={() => setExpandedGroup(expanded ? undefined : group.id)} disabled={searching}>
          <span className="manual-group-chevron" aria-hidden="true">›</span>
          <span className="manual-group-title">{group.title}</span>
          {current && <span className="manual-group-current" aria-hidden="true" />}
          <span className="manual-group-count">{group.chapters.length}</span>
        </button>
        <div className="manual-group-links" id={`manual-group-${group.id}`} hidden={!expanded}>
          {expanded && group.chapters.map(chapter => <a key={chapter.id} href={`#docs/${chapter.id}`} aria-current={chapter.id === chapterId ? 'page' : undefined}>{chapter.title}</a>)}
        </div>
      </div>
    })}
    {!groups.length && <p>{t('manual.noResults')}</p>}
  </nav>
}

export function ManualPage({ chapterId }: { chapterId: string }) {
  const { t, lang } = useI18n()
  const [query, setQuery] = useState('')
  const [directoryOpen, setDirectoryOpen] = useState(true)
  const chapters = getManualChapters(lang)
  const chapter = chapters.find(c => c.id === chapterId) ?? chapters[0]
  const index = chapters.indexOf(chapter)
  const previousArrow = languageDirection(lang) === 'rtl' ? '→' : '←'
  const nextArrow = languageDirection(lang) === 'rtl' ? '←' : '→'
  return <main className="manual-layout" id="manual" lang={lang} dir={languageDirection(lang)}>
    <aside className="manual-sidebar">
      <a className="manual-home" href="#top">{previousArrow} {t('manual.home')}</a>
      <h1>{t('manual.title')}</h1>
      <label className="manual-search-label" htmlFor="manual-search">{t('manual.search')}</label>
      <input id="manual-search" type="search" value={query} onChange={e => {
        setQuery(e.target.value)
        if (e.target.value.trim()) setDirectoryOpen(true)
      }} placeholder={t('manual.searchPlaceholder')} />
      <div className="manual-directory">
        <button className="manual-directory-toggle" type="button" aria-expanded={directoryOpen} aria-controls="manual-navigation" onClick={() => setDirectoryOpen(!directoryOpen)}>{t('manual.chapters')}</button>
        <div className="manual-directory-content" id="manual-navigation" hidden={!directoryOpen}>
          <ManualDirectory key={chapter.id} chapterId={chapter.id} query={query} />
        </div>
      </div>
    </aside>
    <article className="manual-article" lang={lang} key={chapter.id}>
      {lang !== 'zh-CN' && <p className="manual-language-note">{t('manual.screenshotNotice')}</p>}
      <h2>{chapter.title}</h2><p className="manual-summary">{chapter.summary}</p>
      {chapter.sections.map((section, sectionIndex) => {
        const source = section.screenshot && screenshotUrl(section.screenshot.id)
        return <section className="manual-section" key={section.title} id={`manual-section-${sectionIndex}`}>
          <h3>{section.title}</h3>
          <ol>{section.steps.map(step => <li key={step}>{step}</li>)}</ol>
          {section.tips?.map(tip => <p className="manual-tip" key={tip}>{tip}</p>)}
          {source && section.screenshot && <figure><a href={source} target="_blank" rel="noreferrer" aria-label={`${t('manual.enlarge')}：${section.screenshot.alt}`}><img src={source} alt={section.screenshot.alt} loading="lazy" /></a><figcaption>{section.screenshot.caption}</figcaption></figure>}
          {section.screenshot && !source && <p className="manual-tip">{t('manual.screenshotPending')}</p>}
        </section>
      })}
      <nav className="manual-pagination" aria-label={t('manual.pagination')}>
        {index > 0 && <a href={`#docs/${chapters[index - 1].id}`}>{previousArrow} {chapters[index - 1].title}</a>}
        {index < chapters.length - 1 && <a href={`#docs/${chapters[index + 1].id}`}>{chapters[index + 1].title} {nextArrow}</a>}
      </nav>
    </article>
  </main>
}
