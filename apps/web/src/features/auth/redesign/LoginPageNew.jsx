import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuthStore } from '@/auth/store';
import { Icon } from '@/ui/icons.jsx';
import { Button } from '@/ui/primitives.jsx';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { BrandLogo } from '@/ui/BrandLogo.jsx';

/**
 * SIGN IN. Uses the existing authentication architecture unchanged — the same
 * store action, the same httpOnly refresh-cookie contract, the same access and
 * scope rules. Only the presentation is designed here: a white page with the
 * Abstract ABA logo and a large brand heading on the left, and a premium sign-in
 * card on the right with show / hide password, remember me, forgot password,
 * inline validation and clear loading and error states. The product copy only
 * describes what the software does — no invented figures or claims.
 */
const HIGHLIGHTS = [
  { icon: Icon.Calendar, text: 'Scheduling, live sessions and worked time in one place' },
  { icon: Icon.Doc, text: 'Treatment plans, clients and care teams' },
  { icon: Icon.Wallet, text: 'Insurance billing and payroll from completed work' },
];

export function LoginPageNew() {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const signIn = useAuthStore((s) => s.signIn);
  const reduce = useReducedMotion();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const emailInvalid = touched && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordMissing = touched && !password;
  const busy = status === 'authenticating';
  const rise = (delay = 0) => (reduce ? {} : { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] } });

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (busy) return; // already authenticating — ignore repeat submits (one click → one request)
    if (!email || !password || emailInvalid) return;
    // Await the store action so the whole sign-in transition (loading →
    // resolved/navigate) is a single coherent, awaitable unit. All async state
    // lives in the store; this component sets no local state after the await.
    await signIn(email, password, remember);
  }

  return (
    <div className="rx-signin">
      <div className="rx-signin__decor" aria-hidden="true">
        <span className="rx-signin__glow rx-signin__glow--primary" />
        <span className="rx-signin__glow rx-signin__glow--secondary" />
        <span className="rx-signin__grid" />
      </div>

      <main className="rx-signin__stage">
        <section className="rx-signin__intro" aria-label={`About ${PLATFORM_BRAND.productName}`}>
          <motion.div className="rx-signin__logo" {...rise(0)}>
            <BrandLogo size="md" />
          </motion.div>
          <motion.h1 className="rx-signin__title" {...rise(0.06)}>Sign in to your account</motion.h1>
          <motion.p className="rx-signin__welcome" {...rise(0.1)}>Welcome to {PLATFORM_BRAND.productName}</motion.p>
          <motion.p className="rx-signin__lead" {...rise(0.14)}>
            Practice management for ABA teams — clients, staff, scheduling, sessions, insurance billing and payroll,
            with role-based access for owners, BCBAs and RBTs.
          </motion.p>
          <motion.ul className="rx-signin__highlights" {...rise(0.18)}>
            {HIGHLIGHTS.map((h) => (
              <li key={h.text}>
                <span className="rx-signin__highlight-icon" aria-hidden="true"><h.icon size={16} /></span>
                <span>{h.text}</span>
              </li>
            ))}
          </motion.ul>
        </section>

        <motion.section className="rx-signin__card" aria-labelledby="signin-title" {...(reduce ? {} : { initial: { opacity: 0, y: 24, scale: 0.985 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { duration: 0.6, delay: 0.08, ease: [0.22, 1, 0.36, 1] } })}>
          <header className="rx-signin__card-head">
            <span className="rx-signin__card-icon" aria-hidden="true"><Icon.Shield size={22} /></span>
            <div>
              <h2 id="signin-title">Secure sign-in</h2>
              <p>Use your work email and password.</p>
            </div>
          </header>

          <div className="rx-signin__card-body">
            {error && (
              <div className="rx-alert rx-signin__alert" role="alert">
                <Icon.Bell size={18} /> <span>{error}</span>
              </div>
            )}

            <form onSubmit={submit} noValidate>
              <div className="rx-field">
                <label htmlFor="email">Email address</label>
                <div className={`rx-input${emailInvalid ? ' rx-input--error' : ''}`}>
                  <Icon.User size={18} />
                  <input id="email" type="email" autoComplete="username" placeholder="name@company.com"
                    value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} required
                    aria-invalid={emailInvalid || undefined} aria-describedby={emailInvalid ? 'email-error' : undefined} />
                </div>
                {emailInvalid && <span id="email-error" className="rx-signin__error">Enter a valid email address.</span>}
              </div>

              <div className="rx-field">
                <label htmlFor="password">Password</label>
                <div className={`rx-input${passwordMissing ? ' rx-input--error' : ''}`}>
                  <Icon.Shield size={18} />
                  <input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password"
                    value={password} onChange={(e) => setPassword(e.target.value)} required
                    aria-invalid={passwordMissing || undefined} aria-describedby={passwordMissing ? 'password-error' : undefined} />
                  <button type="button" className="rx-input__btn" onClick={() => setShow((v) => !v)}
                    aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                    {show ? <Icon.EyeOff size={18} /> : <Icon.Eye size={18} />}
                  </button>
                </div>
                {passwordMissing && <span id="password-error" className="rx-signin__error">Enter your password.</span>}
              </div>

              <div className="rx-signin__row">
                <label className="rx-check">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me on this device
                </label>
                <a className="rx-link" href="/forgot-password">Forgot password?</a>
              </div>

              <Button type="submit" size="lg" block loading={busy} className="rx-signin__submit">
                {busy ? 'Signing in…' : 'Sign in'}
                {busy ? null : <Icon.Arrow size={18} />}
              </Button>
            </form>

            <p className="rx-signin__assure">
              <Icon.Shield size={14} aria-hidden="true" />
              <span>Access is limited to your organization and your role.</span>
            </p>
          </div>
        </motion.section>
      </main>

      <footer className="rx-signin__foot">
        <div className="rx-signin__foot-inner">
          <span>© {new Date().getFullYear()} {PLATFORM_BRAND.productName}</span>
          <span>Product of {PLATFORM_BRAND.providerName}</span>
        </div>
      </footer>
    </div>
  );
}

export default LoginPageNew;
