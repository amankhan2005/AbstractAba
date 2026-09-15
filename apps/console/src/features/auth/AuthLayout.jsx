import { motion, useReducedMotion } from 'framer-motion';
import { Icon, BrandLogo } from '@/components';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Shared frame for the public console pages (sign in, forgot password, reset
 * password): a white page with the Abstract ABA logo and a large brand heading,
 * and a premium card holding the page's form. `cardTitle` adds the brand
 * gradient header band; pages without one get a slim gradient accent instead.
 * Copy describes what the console is for — no metrics or invented claims.
 */
export function AuthLayout({
  eyebrow = `Welcome to ${PLATFORM_BRAND.productName}`,
  title = 'Platform Console',
  lead = 'Super Admin access for Abstract ABA platform administrators.',
  cardTitle,
  cardSubtitle,
  cardIcon = 'lock',
  children,
}) {
  const reduce = useReducedMotion();
  const rise = (delay = 0) => (reduce ? {} : { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] } });
  return (
    <div className="rxc-auth">
      <div className="rxc-auth__decor" aria-hidden="true">
        <span className="rxc-auth__glow rxc-auth__glow--primary" />
        <span className="rxc-auth__glow rxc-auth__glow--secondary" />
        <span className="rxc-auth__grid" />
      </div>

      <main className="rxc-auth__stage">
        <section className="rxc-auth__intro" aria-label={`About ${PLATFORM_BRAND.productName}`}>
          <motion.div className="rxc-auth__logo" {...rise(0)}>
            <BrandLogo size="md" fallback={<span className="rxc-logo"><span className="rxc__mark" aria-hidden="true">{PLATFORM_BRAND.productMark}</span><span className="rxc-auth__brandname">{PLATFORM_BRAND.productName}</span></span>} />
          </motion.div>
          <motion.h1 className="rxc-auth__headline" {...rise(0.06)}>{title}</motion.h1>
          <motion.p className="rxc-auth__welcome" {...rise(0.1)}>{eyebrow}</motion.p>
          {lead ? <motion.p className="rxc-auth__lead" {...rise(0.14)}>{lead}</motion.p> : null}
          <motion.ul className="rxc-auth__points" {...rise(0.18)}>
            <li><span className="rxc-auth__point-icon" aria-hidden="true"><Icon name="building" size={16} /></span>Company onboarding and lifecycle</li>
            <li><span className="rxc-auth__point-icon" aria-hidden="true"><Icon name="card" size={16} /></span>Plans, invoices and payments</li>
            <li><span className="rxc-auth__point-icon" aria-hidden="true"><Icon name="shield" size={16} /></span>State-specific insurance catalog</li>
          </motion.ul>
        </section>

        <motion.section
          className={`rxc-auth__card${cardTitle ? '' : ' rxc-auth__card--plain'}`}
          aria-labelledby={cardTitle ? 'rxc-auth-card-title' : undefined}
          {...(reduce ? {} : { initial: { opacity: 0, y: 24, scale: 0.985 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { duration: 0.6, delay: 0.08, ease: [0.22, 1, 0.36, 1] } })}
        >
          {cardTitle ? (
            <header className="rxc-auth__card-head">
              <span className="rxc-auth__card-icon" aria-hidden="true"><Icon name={cardIcon} size={22} /></span>
              <div>
                <h2 id="rxc-auth-card-title">{cardTitle}</h2>
                {cardSubtitle ? <p>{cardSubtitle}</p> : null}
              </div>
            </header>
          ) : null}
          <div className="rxc-auth__card-body">{children}</div>
        </motion.section>
      </main>

      <footer className="rxc-auth__legal">
        <div className="rxc-auth__legal-inner">
          <span>© {new Date().getFullYear()} {PLATFORM_BRAND.productName}</span>
          <span>Product of {PLATFORM_BRAND.providerName}</span>
        </div>
      </footer>
    </div>
  );
}

export default AuthLayout;
