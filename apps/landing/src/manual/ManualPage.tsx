import { useState } from 'react'
import { useI18n } from '../i18n'
import { manualChapters, manualGroups, getManualGroups, screenshotUrl } from './content'
import './manual.css'

function ManualDirectory({ chapterId, query }: { chapterId: string; query: string }) {
  const { t } = useI18n()
  const [expandedGroup, setExpandedGroup] = useState(() => manualGroups.find(group => group.chapterIds.includes(chapterId))?.id)
  const groups = getManualGroups(query)
  const searching = Boolean(query.trim())
  return <nav className="manual-groups" aria-label={t('manual.chapters')} lang="zh-CN">
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
  const chapter = manualChapters.find(c => c.id === chapterId) ?? manualChapters[0]
  const index = manualChapters.indexOf(chapter)
  return <main className="manual-layout" id="manual">
    <aside className="manual-sidebar">
      <a className="manual-home" href="#top">← {t('manual.home')}</a>
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
    <article className="manual-article" lang="zh-CN" key={chapter.id}>
      {lang !== 'zh-CN' && <p className="manual-language-note">{t('manual.chineseNotice')}</p>}
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
        {index > 0 && <a href={`#docs/${manualChapters[index - 1].id}`}>← {manualChapters[index - 1].title}</a>}
        {index < manualChapters.length - 1 && <a href={`#docs/${manualChapters[index + 1].id}`}>{manualChapters[index + 1].title} →</a>}
      </nav>
    </article>
  </main>
}
