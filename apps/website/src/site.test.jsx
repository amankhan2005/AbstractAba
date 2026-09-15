// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { routes } from '@/app/routes.jsx';
import { readSiteEnv, siteEnv } from '@/config/env';
import { submitInquiry, InquiryError } from '@/api/inquiries';
import { SUCCESS_MESSAGE, validateInquiry } from '@/pages/ContactPage.jsx';

/**
 * ABSTRACT ABA PUBLIC WEBSITE (apps/website). Renders the real route table in a
 * memory router: Home content rules, navigation and the external Sign In link,
 * the Contact form against a mocked fetch (validation, success, friendly
 * errors), the legal pages and the 404 page. The API side of the contact flow
 * is covered by apps/api (inquiries.test.js, inquiries-db.test.js).
 */
let host; let root; let reducedMotion = false;
const FORBIDDEN = /ABA1ON1|HIPAA (certified|compliant)|100%|zero logs|never store/i;

beforeEach(() => {
  reducedMotion = false;
  window.matchMedia = (query) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent: () => false,
  });
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.scrollTo = () => {};
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); root = undefined; host = undefined;
});

let router;
async function mountAt(path) {
  router = createMemoryRouter(routes, { initialEntries: [path] });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<RouterProvider router={router} />); });
}
const text = () => host.textContent;
const setField = async (id, value) => {
  const el = host.querySelector(`#${id}`);
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submitForm = async () => {
  await act(async () => {
    host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const fillValid = async () => {
  await setField('contact-name', 'Jane Doe');
  await setField('contact-organization', 'Bright Steps ABA');
  await setField('contact-email', 'jane@brightsteps.example');
  await setField('contact-subject', 'Product walkthrough');
  await setField('contact-message', 'We would like to learn more about scheduling.');
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('Configuration', () => {
  it('Sign In points at the existing web panel login; the API defaults to the /api proxy', () => {
    expect(readSiteEnv({})).toEqual({ apiBaseUrl: '/api', webAppUrl: 'http://localhost:3000', signInUrl: 'http://localhost:3000/login' });
    expect(readSiteEnv({ VITE_WEB_APP_URL: 'https://app.example.com/', VITE_API_BASE_URL: 'https://api.example.com/api/' }))
      .toEqual({ apiBaseUrl: 'https://api.example.com/api', webAppUrl: 'https://app.example.com', signInUrl: 'https://app.example.com/login' });
  });

  it('registers only the public routes (no login or panel routes in this app)', () => {
    expect(routes.map((r) => r.path)).toEqual(['/', '/contact', '/privacy-policy', '/terms-and-conditions', '*']);
  });
});

describe('Home page', () => {
  it('renders every section, the logo and the brand details', async () => {
    await mountAt('/');
    for (const heading of [
      'Modern ABA Practice Management', 'Built for Better Care.',
      'brings clients, staff, scheduling, sessions, treatment plans, insurance billing, payroll and practice operations into one role-based workspace',
      'One workspace for your ABA practice',
      'Client Management', 'Staff Management', 'Scheduling', 'Session Management',
      'Treatment Plans', 'Insurance Billing', 'Payroll', 'Role-Based Access',
      'Company / Admin', 'Organization and practice management',
      'BCBA', 'Clinical supervision, treatment planning and session review',
      'RBT', 'Session delivery and daily clinical workflow',
      'Super Admin', 'Platform administration',
      'Set Up Your Organization', 'Manage Your Practice', 'Deliver & Document Care', 'Manage Billing & Payroll',
      'Role-based access', 'Organization separation', 'Secure authentication', 'Controlled access to sensitive information', 'Protected data and document workflows',
      'Ready to simplify your ABA practice?',
      'Product of WebieApp Solutions LLC', 'info@abstractaba.com',
    ]) expect(text()).toContain(heading);
    expect(host.querySelector('#features')).not.toBeNull();
    expect(host.querySelector('#how-it-works')).not.toBeNull();
    expect(host.querySelector('img.site-logo__img').getAttribute('src')).toBe('/logo.png');
    expect(document.title).toBe('ABA Practice Management Software | Abstract ABA');
  });

  it('links: navigation, Contact Us, and Sign In to the web panel login (not a local route)', async () => {
    await mountAt('/');
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/', '/#features', '/#how-it-works', '/privacy-policy', '/terms-and-conditions', '/contact']));
    const signIns = [...host.querySelectorAll('a')].filter((a) => a.textContent.trim() === 'Sign In');
    expect(signIns.length).toBeGreaterThanOrEqual(2);
    for (const a of signIns) expect(a.getAttribute('href')).toBe(siteEnv.signInUrl);
    expect(hrefs).not.toContain('/login');
  });

  it('makes no unsupported claims and shows no legacy product name', async () => {
    await mountAt('/');
    expect(text()).not.toMatch(FORBIDDEN);
  });

  it('toggles the mobile menu with an accessible button', async () => {
    await mountAt('/');
    const toggle = host.querySelector('.ps-nav__toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.ps-nav__menu a[href="/contact"]')).not.toBeNull();
  });

  it('renders fully with reduced motion preferred', async () => {
    reducedMotion = true;
    await mountAt('/');
    expect(text()).toContain('Built for Better Care.');
    expect(host.querySelectorAll('.ps-feature').length).toBe(8);
  });
});

describe('Contact page', () => {
  it('validates required fields accessibly and does not submit', async () => {
    await mountAt('/contact');
    expect(text()).toContain('Let\'s Talk');
    expect(text()).toContain('Tell us a little about your organization and how we can help.');
    await submitForm();
    expect(fetch).not.toHaveBeenCalled();
    const name = host.querySelector('#contact-name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe('contact-name-error');
    expect(host.querySelector('#contact-email-error')).not.toBeNull();
    expect(host.querySelector('#contact-phone-error')).toBeNull();
    expect(document.activeElement).toBe(name);
  });

  it('client rules mirror the server limits', () => {
    const ok = { name: 'Jane Doe', organization: 'Bright', email: 'jane@x.co', phone: '', subject: 'Hello', message: 'Tell me more please' };
    expect(validateInquiry(ok)).toEqual({});
    expect(validateInquiry({ ...ok, phone: 'call me' }).phone).toBeTruthy();
    expect(validateInquiry({ ...ok, message: 'x'.repeat(5001) }).message).toBeTruthy();
  });

  it('posts trimmed values to the existing API without credentials and shows the confirmation', async () => {
    fetch.mockResolvedValue(jsonResponse(201, { data: { received: true } }));
    await mountAt('/contact');
    await fillValid();
    await setField('contact-phone', '  ');
    await submitForm();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/v1/public/inquiries');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      name: 'Jane Doe', organization: 'Bright Steps ABA', email: 'jane@brightsteps.example',
      subject: 'Product walkthrough', message: 'We would like to learn more about scheduling.', website: '',
    });
    expect(SUCCESS_MESSAGE).toBe('Thank you for contacting Abstract ABA. We’ve received your inquiry and our team will connect with you soon.');
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(text()).toContain(SUCCESS_MESSAGE);
  });

  it('shows a friendly error without technical details when the network fails', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch: ECONNREFUSED 127.0.0.1'));
    await mountAt('/contact');
    await fillValid();
    await submitForm();
    expect(host.querySelector('[role="alert"]').textContent).toMatch(/couldn’t send your message/);
    expect(text()).not.toMatch(/ECONNREFUSED|Failed to fetch/);
  });

  it('maps server field errors and rate limiting to friendly messages', async () => {
    fetch.mockResolvedValueOnce(jsonResponse(422, { error: { code: 'VALIDATION_FAILED', details: { fieldErrors: { email: ['Enter a valid work email.'] } } } }));
    await mountAt('/contact');
    await fillValid();
    await submitForm();
    expect(host.querySelector('#contact-email-error').textContent).toBe('Enter a valid work email.');
    expect(text()).not.toContain('VALIDATION_FAILED');

    fetch.mockResolvedValueOnce(jsonResponse(429, { error: { code: 'INQUIRY-429' } }));
    await submitForm();
    expect(host.querySelector('[role="alert"]').textContent).toMatch(/several messages in a short time/);
  });

  it('submitInquiry raises InquiryError with the status for non-2xx responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } }));
    await expect(submitInquiry({}, { fetchImpl, baseUrl: 'https://api.example.com/api' })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.com/api/v1/public/inquiries');
    await expect(submitInquiry({}, { fetchImpl: vi.fn().mockRejectedValue(new Error('x')) })).rejects.toBeInstanceOf(InquiryError);
  });
});

describe('Legal and fallback pages', () => {
  it('Privacy Policy covers the required topics and separates provider from customer data', async () => {
    await mountAt('/privacy-policy');
    const t = text();
    for (const topic of ['Information submitted through the website', 'How we use inquiry information', 'Communications', 'Technical and usage information', 'Customer organization data in the platform', 'Security', 'Third-party services', 'Email', 'Data retention', 'Your choices and rights', 'Contact us', 'WebieApp Solutions LLC', 'info@abstractaba.com']) {
      expect(t).toContain(topic);
    }
    expect(t).toContain('We are not a healthcare provider');
    expect(t).not.toMatch(FORBIDDEN);
    expect(document.title).toBe('Privacy Policy | Abstract ABA');
  });

  it('Terms & Conditions cover the required topics', async () => {
    await mountAt('/terms-and-conditions');
    const t = text();
    for (const topic of ['Use of the website', 'Use of the platform', 'Account responsibility', 'Authorized access', 'Customer organization responsibilities', 'Acceptable use', 'Intellectual property', 'Service availability', 'Third-party services', 'limitation of liability', 'termination', 'Changes to these terms', 'Contact']) {
      expect(t).toContain(topic);
    }
    expect(t).toContain('WebieApp Solutions LLC provides practice management software. We are not a healthcare provider');
    expect(t).not.toMatch(FORBIDDEN);
  });

  it('unknown paths show a friendly 404 with a way home', async () => {
    await mountAt('/does-not-exist');
    expect(text()).toContain('Page not found');
    expect(host.querySelector('a[href="/"]')).not.toBeNull();
  });
});
