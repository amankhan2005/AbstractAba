import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Onboarding wizard — Pending #8 + the preserved accept contracts.
 *
 * Drives the real multi-step component: step validation gates advancing, the
 * agreement modal gates the final submit, and submit sends exactly what the
 * accept endpoint expects (derived slug, agreement.accepted, acceptedByTitle,
 * and NO email/locale/state). Also pins the original bug-report contracts:
 * one POST per double-click, auto-login → navigate, server-error → no navigate,
 * session-fallback → sign in. act()-clean throughout (warnings fail the suite).
 */

const previewCompanyInvitation = vi.fn();
const submitCompanyOnboarding = vi.fn();
const adoptSession = vi.fn();
const navigate = vi.fn();

vi.mock('@/api/client', async (orig) => ({
  ...(await orig()),
  previewCompanyInvitation: (...a) => previewCompanyInvitation(...a),
  submitCompanyOnboarding: (...a) => submitCompanyOnboarding(...a),
}));
vi.mock('@/auth/store', () => ({ useAuthStore: (selector) => selector({ adoptSession }) }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ token: 'tok-onboard-123' }) };
});

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((args) => /not wrapped in act/i.test(String(args[0] ?? '')));

let CompanyOnboardingPage;
beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ CompanyOnboardingPage } = await import('./CompanyOnboardingPage.jsx'));
  previewCompanyInvitation.mockReset();
  submitCompanyOnboarding.mockReset();
  adoptSession.mockReset();
  navigate.mockReset();
  previewCompanyInvitation.mockResolvedValue({
    email: 'owner@clinic.test',
    companyName: 'Sunrise ABA',
    agreement: { type: 'BUSINESS_ASSOCIATE', title: 'Business Associate Agreement', version: '1.0' },
  });
});

let host; let root;
const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/onboarding/tok-onboard-123']}><CompanyOnboardingPage /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
};
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const warnings = actWarnings(); consoleErrorSpy.mockRestore();
  expect(warnings, `act() warnings: ${JSON.stringify(warnings)}`).toHaveLength(0);
});

const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); }); };
const waitFor = async (re) => {
  for (let i = 0; i < 50; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  throw new Error(`missing ${re}: ${host.textContent.slice(0, 200)}`);
};
const byId = (id) => host.querySelector(`#${id}`);
const setById = (id, value) => {
  const input = byId(id);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};
const clickText = async (re, scope = document) => {
  const b = [...scope.querySelectorAll('button')].find((x) => re.test(x.textContent));
  if (!b) throw new Error(`no button matching ${re}`);
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const btn = (re, scope = document) => [...scope.querySelectorAll('button')].find((x) => re.test(x.textContent));

const waitForId = async (id) => {
  for (let i = 0; i < 50; i += 1) { if (host.querySelector(`#${id}`)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  throw new Error(`missing #${id}: ${host.textContent.slice(0, 200)}`);
};

// Advance through steps 1 → 4 with valid data (country/timezone keep defaults).
const goToAgreementStep = async () => {
  await waitForId('ob-trading');
  setById('ob-trading', 'Sunrise ABA');
  setById('ob-legal', 'Sunrise ABA Therapy, LLC');
  await clickText(/Continue/, host);
  await waitForId('ob-name');
  setById('ob-name', 'Jordan Lee');
  setById('ob-title', 'Owner');
  setById('ob-pw', 'a-strong-password-1');
  setById('ob-pw2', 'a-strong-password-1');
  await clickText(/Continue/, host);   // → review
  await waitFor(/Login email/);        // review step shows the summary
  await clickText(/Continue/, host);   // → agreement
  await waitFor(/Review terms/);
};
const acceptAgreement = async () => {
  await clickText(/Review terms/, host);           // open modal (portal → document)
  const cb = document.querySelector('.rx-modal input[type="checkbox"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
  setter.call(cb, true);
  await act(async () => { cb.dispatchEvent(new Event('click', { bubbles: true })); await Promise.resolve(); });
  await clickText(/I Agree/, document);            // confirm → closes modal
  await flush();
};
const errorText = () => host.querySelector('.rx-formfield__err')?.textContent ?? null;

describe('CompanyOnboardingPage — wizard', () => {
  it('opens the timezone menu outside the clipping card, with every option selectable', async () => {
    mount(); await waitForId('ob-tz');
    const card = host.querySelector('.rx-onb__card');
    const trigger = host.querySelector('#ob-tz');
    expect(host.querySelector('label[for="ob-tz"]')).toBeTruthy(); // the label targets the field
    await act(async () => { trigger.click(); });
    const menu = document.querySelector('.rx-select__menu');
    expect(menu).toBeTruthy();
    expect(card.contains(menu)).toBe(false); // portalled: .rx-onb__card overflow cannot clip it
    const options = [...menu.querySelectorAll('.rx-select__opt')];
    expect(options).toHaveLength(7);
    await act(async () => { options[6].click(); });
    expect(trigger.textContent).toMatch(/Hawaii|Honolulu/);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the company setup under the Abstract ABA brand (never ABA1ON1)', async () => {
    mount(); await waitForId('ob-tz');
    const page = document.querySelector('.rx-onb');
    expect(page.querySelector('.rx-gate__brand').textContent).toBe('Abstract ABA');
    expect(page.querySelector('.rx-gate__brand img').getAttribute('src')).toBe('/logo.png');
    expect(page.querySelector('.rx-gate__foot').textContent).toMatch(/Product of WebieApp Solutions LLC/);
    expect(page.textContent).toMatch(/Welcome to Abstract ABA/);
    expect(page.textContent).not.toMatch(/ABA1ON1/);
  });

  it('presents the Company Onboarding Agreement: provider, sections, privacy wording, recorded agreement — and no certification claims', async () => {
    mount(); await goToAgreementStep();
    expect(host.textContent).toMatch(/Company Onboarding Agreement/);
    await clickText(/Review terms/, host);
    const dialog = document.querySelector('.rx-modal [role="dialog"]');
    expect(dialog.getAttribute('aria-label')).toBe('Company Onboarding Agreement');
    const text = dialog.textContent;
    expect(text).toMatch(/Welcome to Abstract ABA/);
    expect(text).toMatch(/between Sunrise ABA and WebieApp Solutions LLC, the provider of Abstract ABA/);
    const headings = [...dialog.querySelectorAll('.rx-onb__terms-sections h3')].map((h) => h.textContent);
    expect(headings).toEqual(['Platform provider', 'Organization responsibilities', 'Data privacy', 'Security', 'Healthcare information', 'Platform usage', 'Acceptance']);
    expect(text).toMatch(/does not use the platform to independently monitor your employees/);
    expect(text).toMatch(/processes the information necessary to provide, maintain, secure and operate the service/);
    expect(text).toMatch(/recorded as the Business Associate Agreement \(v1\.0\) for Sunrise ABA/); // server-pinned agreement preserved
    expect(text).toMatch(/info@abstractaba\.com/);
    expect(text).not.toMatch(/HIPAA[- ]compliant|certified|SOC ?2|ISO ?27001|no data|no logs|never track/i);
    expect(text).not.toMatch(/ABA1ON1/);
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(text).toMatch(/I have read and agree to the Company Onboarding Agreement on behalf of Sunrise ABA/);
    // I Agree stays disabled until the box is checked.
    const agree = [...dialog.querySelectorAll('button')].find((b) => /I Agree/.test(b.textContent));
    expect(agree.disabled).toBe(true);
  });

  it('asks only for required information: no optional fields, no "(optional)" labels, no operating states', async () => {
    mount(); await waitFor(/Company name/);
    expect(host.textContent).not.toMatch(/optional/i);
    expect(host.textContent).not.toMatch(/Operating states/i);
    expect([...host.querySelectorAll('.rx-formfield > label')].map((l) => l.textContent)).toEqual(['Company name*', 'Legal company name*', 'Country*', 'Timezone*']);
    expect(host.querySelector('#onb-step-title').textContent).toBe('Company information');
    expect(host.querySelector('.rx-onb__count').textContent).toBe('Step 1 of 4');
    setById('ob-trading', 'Sunrise ABA');
    setById('ob-legal', 'Sunrise ABA Therapy, LLC');
    await clickText(/Continue/, host);
    await waitForId('ob-name');
    for (let i = 0; i < 50 && host.querySelector('#ob-trading'); i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); // step exit animation
    expect([...host.querySelectorAll('.rx-formfield > label')].map((l) => l.textContent)).toEqual(['Your name*', 'Your title*', 'Password*', 'Confirm password*']);
    expect(host.querySelectorAll('input[disabled]').length).toBe(0);
    expect(host.textContent).toContain('You will sign in with owner@clinic.test');
    expect([...host.querySelectorAll('.rx-onb__step')].map((li) => li.className.replace('rx-onb__step ', ''))).toEqual(['is-done', 'is-current', 'is-todo', 'is-todo']);
    expect(host.textContent).not.toMatch(/optional/i);
  });

  it('gates advancing until the current step is valid (#7 step validation)', async () => {
    mount(); await waitFor(/Company name/);
    await clickText(/Continue/, host); // step 0 invalid → should not advance
    await flush();
    expect(host.textContent).toMatch(/Please enter your company name/);
    expect(host.textContent).toMatch(/Company name/); // still on step 1
  });

  it('blocks Complete setup until the agreement is accepted, then submits the correct payload', async () => {
    submitCompanyOnboarding.mockResolvedValue({ organizationId: 'org-1', state: 'ACTIVE', session: { status: 'ESTABLISHED', accessToken: 'AT' } });
    adoptSession.mockResolvedValue(true);
    mount(); await waitFor(/Company name/);
    await goToAgreementStep();

    // Complete setup is disabled before acceptance.
    expect(btn(/Complete setup/, host).disabled).toBe(true);

    await acceptAgreement();
    expect(btn(/Complete setup/, host).disabled).toBe(false);

    await clickText(/Complete setup/, host);
    await flush();

    expect(submitCompanyOnboarding).toHaveBeenCalledTimes(1);
    const [tok, details] = submitCompanyOnboarding.mock.calls[0];
    expect(tok).toBe('tok-onboard-123');
    expect(details.slug).toBe('sunrise-aba');          // derived, never asked
    expect(details.agreement).toMatchObject({ accepted: true, acceptedByTitle: 'Owner', version: '1.0' });
    expect(details.primaryContactName).toBe('Jordan Lee');
    expect(details).not.toHaveProperty('primaryContactEmail'); // comes from invitation
    expect(details).not.toHaveProperty('locale');
    expect(details).not.toHaveProperty('serviceStates'); // optional — not collected during onboarding
    expect(Object.keys(details).sort()).toEqual(['agreement', 'countryCode', 'legalName', 'password', 'primaryContactName', 'slug', 'timezone', 'tradingName']);
    // Auto-login → Company Panel.
    expect(adoptSession).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('a rapid double-click on Complete setup fires submit exactly once', async () => {
    submitCompanyOnboarding.mockResolvedValue({ organizationId: 'org-1', state: 'ACTIVE', session: { status: 'ESTABLISHED', accessToken: 'AT' } });
    adoptSession.mockResolvedValue(true);
    mount(); await waitFor(/Company name/);
    await goToAgreementStep();
    await acceptAgreement();
    const b = btn(/Complete setup/, host);
    await act(async () => {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    await flush();
    expect(submitCompanyOnboarding).toHaveBeenCalledTimes(1);
  });

  it('surfaces a server error and does NOT navigate (#16 server error)', async () => {
    submitCompanyOnboarding.mockRejectedValue({ response: { status: 409, data: { error: { code: 'COMPANY_INVITE-409', message: 'That invitation is no longer active.' } } } });
    mount(); await waitFor(/Company name/);
    await goToAgreementStep();
    await acceptAgreement();
    await clickText(/Complete setup/, host);
    await flush();
    expect(errorText()).toMatch(/no longer active/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls back to sign-in when no session is established (#12 auto-login fallback)', async () => {
    submitCompanyOnboarding.mockResolvedValue({ organizationId: 'org-1', state: 'ACTIVE', session: { status: 'SIGN_IN_REQUIRED' } });
    mount(); await waitFor(/Company name/);
    await goToAgreementStep();
    await acceptAgreement();
    await clickText(/Complete setup/, host);
    await flush();
    expect(adoptSession).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/please sign in/i);
  });

  it('shows an expired/invalid invitation screen (#14/#15)', async () => {
    previewCompanyInvitation.mockRejectedValue(new Error('gone'));
    mount();
    await waitFor(/invalid or has expired/i);
    expect(host.querySelector('#ob-trading')).toBeNull();
  });
});
