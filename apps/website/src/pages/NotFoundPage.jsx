import { Link } from 'react-router-dom';
import { SiteLayout } from '@/components/SiteLayout.jsx';
import { Icon } from '@/components/Icon.jsx';

/** Unknown paths on the public website. */
export function NotFoundPage() {
  return (
    <SiteLayout title="Page not found">
      <section className="ps-page-hero ps-notfound" aria-labelledby="notfound-title">
        <div className="ps-hero__bg" aria-hidden="true" />
        <div className="ps-container ps-notfound__inner">
          <p className="ps-eyebrow">404</p>
          <h1 id="notfound-title" className="ps-h1 ps-h1--page">Page not found</h1>
          <p className="ps-lead">The page you were looking for doesn’t exist or has moved.</p>
          <div className="ps-hero__cta">
            <Link to="/" className="ps-btn ps-btn--primary ps-btn--lg">Back to Home <Icon.Arrow size={18} /></Link>
            <Link to="/contact" className="ps-btn ps-btn--outline ps-btn--lg">Contact Us</Link>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

export default NotFoundPage;
