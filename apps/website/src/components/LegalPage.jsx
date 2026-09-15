import { Link } from 'react-router-dom';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { SiteLayout } from './SiteLayout.jsx';
import { Reveal } from './motion.jsx';

/**
 * Shared layout for legal documents: a page header, an "On this page" table of
 * contents (sticky on wide screens), and numbered sections. Sections are data:
 * { id, title, body: Array<string | { list: string[] } | JSX> }.
 */
export const LEGAL_LAST_UPDATED = 'September 15, 2026';

function Block({ block }) {
  if (typeof block === 'string') return <p>{block}</p>;
  if (block && Array.isArray(block.list)) {
    return <ul>{block.list.map((item) => <li key={typeof item === 'string' ? item : item.key}>{item}</li>)}</ul>;
  }
  return block;
}

export function LegalPage({ title, eyebrow = 'Legal', intro, sections }) {
  return (
    <SiteLayout title={title} description={intro}>
      <section className="ps-page-hero ps-page-hero--legal" aria-labelledby="legal-title">
        <div className="ps-hero__bg" aria-hidden="true" />
        <div className="ps-container">
          <Reveal className="ps-legal__head">
            <p className="ps-eyebrow">{eyebrow}</p>
            <h1 id="legal-title" className="ps-h1 ps-h1--page">{title}</h1>
            <p className="ps-legal__updated">Last updated: {LEGAL_LAST_UPDATED}</p>
            {intro ? <p className="ps-lead">{intro}</p> : null}
          </Reveal>
        </div>
      </section>

      <div className="ps-container ps-legal">
        <nav className="ps-legal__toc" aria-label="On this page">
          <p className="ps-legal__toc-title">On this page</p>
          <ol>
            {sections.map((s, i) => (
              <li key={s.id}><a href={`#${s.id}`}><span aria-hidden="true">{i + 1}.</span> {s.title}</a></li>
            ))}
          </ol>
        </nav>

        <article className="ps-legal__body">
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} className="ps-legal__section" aria-labelledby={`${s.id}-title`}>
              <h2 id={`${s.id}-title`} className="ps-h3"><span className="ps-legal__num" aria-hidden="true">{i + 1}.</span> {s.title}</h2>
              {s.body.map((block, j) => <Block key={j} block={block} />)}
            </section>
          ))}

          <aside className="ps-legal__contact">
            <h2 className="ps-h4">Questions?</h2>
            <p>
              Contact {PLATFORM_BRAND.providerName} at <a href={`mailto:${PLATFORM_BRAND.supportEmail}`}>{PLATFORM_BRAND.supportEmail}</a> or
              use our <Link to="/contact">contact form</Link>.
            </p>
          </aside>
        </article>
      </div>
    </SiteLayout>
  );
}
