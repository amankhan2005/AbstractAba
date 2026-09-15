import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { siteEnv } from '@/config/env';
import { Icon } from '@/components/Icon.jsx';
import { SiteLayout } from '@/components/SiteLayout.jsx';
import { EASE, Reveal, Stagger, StaggerItem } from '@/components/motion.jsx';

/**
 * Public home page for Abstract ABA. Copy describes only what the software
 * does today — no statistics, customer logos, testimonials, certifications or
 * absolute security claims.
 */
const FEATURES = [
  {
    icon: Icon.Child,
    title: 'Client Management',
    text: 'Keep each client’s record organized from intake onward.',
    points: ['Client profiles and intake details', 'Guardian and contact information', 'Insurance coverage and authorizations', 'Assigned care team'],
  },
  {
    icon: Icon.Users,
    title: 'Staff Management',
    text: 'Bring your clinical and administrative team into one workspace.',
    points: ['Staff profiles and roles', 'Email invitations and account activation', 'Care team assignments', 'Pay rates for payroll'],
  },
  {
    icon: Icon.Calendar,
    title: 'Scheduling',
    text: 'Plan appointments around clients, staff and availability.',
    points: ['Appointment calendar', 'Recurring appointments', 'Staff availability', 'Your organization’s business time zone'],
  },
  {
    icon: Icon.Clock,
    title: 'Session Management',
    text: 'Run sessions and capture the work as it happens.',
    points: ['Start and track live sessions', 'Manual session entry when needed', 'Session notes and documentation', 'Oversight for administrators and BCBAs'],
  },
  {
    icon: Icon.Clipboard,
    title: 'Treatment Plans',
    text: 'Maintain treatment plans and goals for every client.',
    points: ['Plans linked to each client', 'Goals with status tracking', 'Visible to the assigned care team', 'Updates as treatment progresses'],
  },
  {
    icon: Icon.Shield,
    title: 'Insurance Billing',
    text: 'Prepare billing from the sessions your team completes.',
    points: ['Insurance catalog by state', 'Billing prepared from completed sessions', 'Remittance (ERA) review', 'Payment reconciliation'],
  },
  {
    icon: Icon.Wallet,
    title: 'Payroll',
    text: 'Turn worked time into payroll with fewer manual steps.',
    points: ['Timesheets from recorded work', 'Staff pay rates', 'Payroll by pay period', 'Period summaries for review'],
  },
  {
    icon: Icon.Lock,
    title: 'Role-Based Access',
    text: 'Everyone sees the tools and information that match their responsibilities.',
    points: ['Company / Admin workspace', 'BCBA workspace', 'RBT workspace', 'Permission-based access to data'],
  },
];

const ROLES = [
  {
    icon: Icon.Building,
    title: 'Company / Admin',
    summary: 'Organization and practice management',
    text: 'Set up the organization, manage staff and clients, oversee scheduling and sessions, and run insurance billing and payroll.',
  },
  {
    icon: Icon.Clipboard,
    title: 'BCBA',
    summary: 'Clinical supervision, treatment planning and session review',
    text: 'Work with assigned clients, maintain treatment plans and goals, review session work, and support the care team.',
  },
  {
    icon: Icon.User,
    title: 'RBT',
    summary: 'Session delivery and daily clinical workflow',
    text: 'See the day’s schedule, run assigned sessions and record session work in a focused, simple workspace.',
  },
  {
    icon: Icon.Cog,
    title: 'Super Admin',
    summary: 'Platform administration',
    text: 'Platform administrators onboard organizations, manage plans and subscriptions, and maintain the platform insurance catalog.',
  },
];

const STEPS = [
  { n: '01', title: 'Set Up Your Organization', text: 'Complete onboarding, add your company profile, and invite your staff with the roles they need.' },
  { n: '02', title: 'Manage Your Practice', text: 'Add clients, assign care teams, set availability and build the schedule.' },
  { n: '03', title: 'Deliver & Document Care', text: 'Run sessions, record the work, and keep treatment plans and goals current.' },
  { n: '04', title: 'Manage Billing & Payroll', text: 'Prepare insurance billing and payroll from completed, recorded work.' },
];

const SECURITY = [
  { icon: Icon.Users, title: 'Role-based access', text: 'Each user’s role determines which workspaces, records and actions are available to them.' },
  { icon: Icon.Building, title: 'Organization separation', text: 'Each organization’s data is kept separate from other organizations on the platform.' },
  { icon: Icon.Lock, title: 'Secure authentication', text: 'Accounts are protected by sign-in controls, password requirements and managed sessions.' },
  { icon: Icon.Shield, title: 'Controlled access to sensitive information', text: 'Staff reach only the clients and information connected to their responsibilities.' },
  { icon: Icon.Doc, title: 'Protected data and document workflows', text: 'Client records and documents are available only to authorized users of the organization.' },
  { icon: Icon.Clipboard, title: 'Activity records', text: 'Important actions are designed to be recorded so organizations can review activity.' },
];

const HERO_MODULES = [
  { icon: Icon.Child, label: 'Clients' },
  { icon: Icon.Calendar, label: 'Scheduling' },
  { icon: Icon.Clock, label: 'Sessions' },
  { icon: Icon.Clipboard, label: 'Treatment Plans' },
  { icon: Icon.Shield, label: 'Insurance Billing' },
  { icon: Icon.Wallet, label: 'Payroll' },
];

function SectionHeading({ eyebrow, title, text, align = 'center', id }) {
  return (
    <Reveal className={`ps-heading ps-heading--${align}`}>
      {eyebrow ? <p className="ps-eyebrow">{eyebrow}</p> : null}
      <h2 className="ps-h2" id={id}>{title}</h2>
      {text ? <p className="ps-lead">{text}</p> : null}
    </Reveal>
  );
}

/** Abstract product illustration: the modules joined in one workspace. Not a screenshot. */
function HeroIllustration() {
  const reduce = useReducedMotion();
  return (
    <div className="ps-hero__art" aria-hidden="true">
      <motion.div
        className="ps-hero__orbit"
        animate={reduce ? undefined : { rotate: 360 }}
        transition={reduce ? undefined : { duration: 60, repeat: Infinity, ease: 'linear' }}
      />
      <motion.div
        className="ps-hero__float"
        animate={reduce ? undefined : { y: [0, -8, 0] }}
        transition={reduce ? undefined : { duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
      >
      <motion.div
        className="ps-hero__panel"
        initial={reduce ? false : { opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.7, delay: 0.15, ease: EASE }}
      >
        <div className="ps-hero__panel-head">
          <span className="ps-hero__dots"><span /><span /><span /></span>
          <span className="ps-hero__panel-title">One workspace</span>
        </div>
        <div className="ps-hero__modules">
          {HERO_MODULES.map((m, i) => (
            <motion.div
              key={m.label}
              className="ps-hero__module"
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 + i * 0.06, ease: EASE }}
            >
              <span className="ps-hero__module-icon"><m.icon size={18} /></span>
              <span>{m.label}</span>
            </motion.div>
          ))}
        </div>
        <div className="ps-hero__roles">
          {['Company / Admin', 'BCBA', 'RBT'].map((r) => <span key={r} className="ps-chip">{r}</span>)}
        </div>
      </motion.div>
      </motion.div>
    </div>
  );
}

export function HomePage() {
  const reduce = useReducedMotion();
  const rise = (delay = 0) => (reduce ? {} : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay, ease: EASE } });

  return (
    <SiteLayout title="ABA Practice Management Software">
      {/* HERO */}
      <section className="ps-hero" aria-labelledby="hero-title">
        <div className="ps-hero__bg" aria-hidden="true" />
        <div className="ps-container ps-hero__grid">
          <div className="ps-hero__copy">
            <motion.p className="ps-eyebrow ps-eyebrow--pill" {...rise(0)}>
              <Icon.Sparkle size={14} /> ABA practice management
            </motion.p>
            <motion.h1 id="hero-title" className="ps-h1" {...rise(0.06)}>
              Modern ABA Practice Management, <span className="ps-gradient-text">Built for Better Care.</span>
            </motion.h1>
            <motion.p className="ps-hero__lead" {...rise(0.12)}>
              {PLATFORM_BRAND.productName} brings clients, staff, scheduling, sessions, treatment plans, insurance
              billing, payroll and practice operations into one role-based workspace.
            </motion.p>
            <motion.div className="ps-hero__cta" {...rise(0.18)}>
              <Link to="/contact" className="ps-btn ps-btn--primary ps-btn--lg">
                Contact Us <Icon.Arrow size={18} />
              </Link>
              <a href={siteEnv.signInUrl} className="ps-btn ps-btn--outline ps-btn--lg">Sign In</a>
            </motion.div>
          </div>
          <HeroIllustration />
        </div>
      </section>

      {/* WHAT IS */}
      <section className="ps-section" aria-labelledby="about-title">
        <div className="ps-container ps-about">
          <SectionHeading
            eyebrow={`What is ${PLATFORM_BRAND.productName}`}
            id="about-title"
            title="One workspace for your ABA practice"
            text={`${PLATFORM_BRAND.productName} brings the everyday operations of an ABA organization together — from client intake and scheduling to session documentation, insurance billing and payroll — so your team spends less time switching between tools and more time on care.`}
          />
          <Stagger className="ps-about__grid">
            {[
              { icon: Icon.Grid, title: 'Connected operations', text: 'Clients, schedules, sessions, billing and payroll share the same records, so work entered once is available where it is needed.' },
              { icon: Icon.Users, title: 'Built around roles', text: 'Company administrators, BCBAs and RBTs each get a workspace designed for their day-to-day work.' },
              { icon: Icon.Shield, title: 'Organized and controlled', text: 'Access follows each person’s role and organization, helping keep information with the people who need it.' },
            ].map((item) => (
              <StaggerItem key={item.title} className="ps-about__item">
                <span className="ps-icon-tile"><item.icon size={20} /></span>
                <h3 className="ps-h4">{item.title}</h3>
                <p>{item.text}</p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="ps-section ps-section--tint" aria-labelledby="features-title">
        <div className="ps-container">
          <SectionHeading
            eyebrow="Features"
            id="features-title"
            title="Everything your practice runs on"
            text="Core tools for clinical operations and the business side of your organization."
          />
          <Stagger className="ps-features" gap={0.05}>
            {FEATURES.map((f) => (
              <StaggerItem key={f.title} as="article" className="ps-feature">
                <span className="ps-icon-tile ps-icon-tile--gradient"><f.icon size={20} /></span>
                <h3 className="ps-h4">{f.title}</h3>
                <p className="ps-feature__text">{f.text}</p>
                <ul className="ps-feature__list">
                  {f.points.map((p) => (
                    <li key={p}><Icon.Check size={14} aria-hidden="true" /><span>{p}</span></li>
                  ))}
                </ul>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* ROLES */}
      <section className="ps-section" aria-labelledby="roles-title">
        <div className="ps-container">
          <SectionHeading
            eyebrow="Role-based experience"
            id="roles-title"
            title="The right workspace for every role"
            text="Each person signs in to a workspace shaped around their responsibilities and permissions."
          />
          <Stagger className="ps-roles">
            {ROLES.map((r) => (
              <StaggerItem key={r.title} as="article" className="ps-role">
                <span className="ps-role__icon"><r.icon size={22} /></span>
                <h3 className="ps-h4">{r.title}</h3>
                <p className="ps-role__summary">{r.summary}</p>
                <p>{r.text}</p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="ps-section ps-section--tint" aria-labelledby="how-title">
        <div className="ps-container">
          <SectionHeading
            eyebrow="How it works"
            id="how-title"
            title="From setup to payroll, step by step"
            text="A clear path from onboarding your organization to closing out billing and payroll."
          />
          <Stagger as="ol" className="ps-steps">
            {STEPS.map((s) => (
              <StaggerItem key={s.n} as="li" className="ps-step">
                <span className="ps-step__num" aria-hidden="true">{s.n}</span>
                <h3 className="ps-h4"><span className="ps-sr">Step {s.n}: </span>{s.title}</h3>
                <p>{s.text}</p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* SECURITY */}
      <section className="ps-section" aria-labelledby="security-title">
        <div className="ps-container ps-security">
          <SectionHeading
            align="start"
            eyebrow="Security & privacy"
            id="security-title"
            title="Designed with privacy and access control in mind"
            text={`${PLATFORM_BRAND.productName} is built to help organizations keep client and business information organized and limited to authorized users. Each organization remains responsible for how it configures access and uses the platform.`}
          />
          <Stagger className="ps-security__grid">
            {SECURITY.map((s) => (
              <StaggerItem key={s.title} className="ps-security__item">
                <span className="ps-icon-tile"><s.icon size={18} /></span>
                <div>
                  <h3 className="ps-h5">{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* CTA */}
      <section className="ps-section ps-section--cta" aria-labelledby="cta-title">
        <div className="ps-container">
          <Reveal className="ps-cta">
            <div className="ps-cta__glow" aria-hidden="true" />
            <h2 id="cta-title" className="ps-h2 ps-cta__title">Ready to simplify your ABA practice?</h2>
            <p className="ps-cta__text">Talk with our team to learn how {PLATFORM_BRAND.productName} can fit your organization&apos;s workflow.</p>
            <Link to="/contact" className="ps-btn ps-btn--light ps-btn--lg">
              Contact Us <Icon.Arrow size={18} />
            </Link>
          </Reveal>
        </div>
      </section>
    </SiteLayout>
  );
}

export default HomePage;
