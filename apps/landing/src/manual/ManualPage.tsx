import { useState } from 'react'
import { useI18n } from '../i18n'
import { manualChapters, screenshotUrl } from './content'
import './manual.css'
export function ManualPage({ chapterId }: { chapterId: string }) {
  const { t, lang } = useI18n()
  const [query, setQuery] = useState('')
  const chapter = manualChapters.find(c => c.id === chapterId) ?? manualChapters[0]
  const normalized = query.trim().toLowerCase()
  const matches = manualChapters.filter(c => !normalized || JSON.stringify(c).toLowerCase().includes(normalized))
  const index = manualChapters.indexOf(chapter)
  return <main className="manual-layout" id="manual">
    <aside className="manual-sidebar">
      <a className="manual-home" href="#top">← {t('manual.home')}</a>
      <h1>{t('manual.title')}</h1>
      <label className="manual-search-label" htmlFor="manual-search">{t('manual.search')}</label>
      <input id="manual-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('manual.searchPlaceholder')} />
      <details className="manual-directory" open><summary>{t('manual.chapters')}</summary>
      <nav aria-label={t('manual.chapters')}>
        {matches.map(c => <a key={c.id} href={`#docs/${c.id}`} aria-current={chapter.id === c.id ? 'page' : undefined}>{c.title}</a>)}
        {!matches.length && <p>{t('manual.noResults')}</p>}
      </nav></details>
    </aside>
    <article className="manual-article" lang="zh-CN" key={chapter.id}>
      {lang === 'en-US' && <p className="manual-language-note">{t('manual.chineseNotice')}</p>}
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
