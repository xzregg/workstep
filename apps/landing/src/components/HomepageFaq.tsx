import { Plus } from 'lucide-react'
import { languageDirection, useI18n } from '../i18n'
import { homepageFaqCopy } from '../i18n/homepageFaq'
import './HomepageFaq.css'

export function HomepageFaq() {
  const { lang } = useI18n()
  const copy = homepageFaqCopy[lang]
  return (
    <section className="section homepage-faq" id="faq" lang={lang} dir={languageDirection(lang)} aria-labelledby="homepage-faq-title">
      <div className="container">
        <div className="homepage-faq-content">
          <h2 className="section-title" id="homepage-faq-title">{copy.title}</h2>
          {copy.items.map(([question, answer], index) => (
            <details className="homepage-faq-item" key={`${lang}-${index}`}>
              <summary>{question}<Plus size={18} aria-hidden="true" /></summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}
