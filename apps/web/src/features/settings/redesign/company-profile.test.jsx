import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Company Profile — Parts 16–19, 34 (#17–#20, #39), 35.
 *
 * Covers: reads the caller's own profile; edits and saves only the changed
 * fields with the current version (If-Match convention); guards the "no changes"
 * case so the min-one-field backend rule is never violated; and survives an
 * unexpected/empty API shape without crashing. Every async settle runs inside
 * act(), and the suite fails on any "not wrapped in act" warning.
 */

const getOrganizationProfile = vi.fn();
const updateOrganizationProfile = vi.fn();
const fetchBranding = vi.fn();
const uploadTenantLogo = vi.fn();
const perms = vi.hoisted(() => ({ list: ['organization.update'], ready: true }));
vi.mock('@/auth/permissions', () => ({
  usePermissions: () => ({ permissions: perms.list, ready: perms.ready, can: (k) => perms.list.includes(k) }),
}));
const fetchMe = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig()),
  fetchMe: (...a) => fetchMe(...a),
  getOrganizationProfile: (...a) => getOrganizationProfile(...a),
  updateOrganizationProfile: (...a) => updateOrganizationProfile(...a),
  fetchBranding: (...a) => fetchBranding(...a),
  uploadTenantLogo: (...a) => uploadTenantLogo(...a),
}));

const PROFILE = {
  id: 'org-1',
  slug: 'bright-aba',
  tradingName: 'Bright ABA',
  legalName: 'Bright ABA LLC',
  state: 'ACTIVE',
  primaryContactName: 'Dana Lee',
  primaryContactEmail: 'dana@bright.test',
  contactEmail: 'hello@bright.test',
  contactPhone: null,
  websiteUrl: null,
  addressLine1: '12 Oak St',
  addressLine2: null,
  city: 'Austin',
  postalCode: '78701',
  countryCode: 'US',
  stateCode: 'TX',
  timezone: 'America/Chicago',
  locale: 'en-US',
  serviceStates: ['TX', 'OK'],
  version: 4,
};

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root;

const mount = async () => {
  const { CompanyProfileRedesign } = await import('./CompanyProfileRedesign.jsx');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter><CompanyProfileRedesign /></MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
};

const waitFor = async (re) => {
  for (let i = 0; i < 60; i += 1) {
    if (re.test(host.textContent)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  throw new Error(`missing ${re}: ${host.textContent.slice(0, 300)}`);
};
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const field = (name) => host.querySelector(`input[name="${name}"]`);
const setField = async (name, value) => {
  const el = field(name);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const clickButton = async (re) => {
  const b = [...host.querySelectorAll('button')].find((x) => re.test(x.textContent));
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};

describe('CompanyProfileRedesign', () => {
  beforeEach(() => {
    perms.list = ['organization.update']; perms.ready = true;
    consoleErrorSpy = vi.spyOn(console, 'error');
    getOrganizationProfile.mockResolvedValue({ ...PROFILE });
    updateOrganizationProfile.mockResolvedValue({ ...PROFILE, tradingName: 'Bright ABA Group', version: 5 });
    fetchBranding.mockResolvedValue({ logoUrl: null });
    uploadTenantLogo.mockResolvedValue({ logoUrl: 'https://cdn.test/logo.png' });
  });
  afterEach(() => {
    if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
    const w = actWarnings(); consoleErrorSpy.mockRestore();
    expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
    vi.clearAllMocks();
  });

  it('reads and renders the company’s own profile (#17)', async () => {
    await mount();
    await waitFor(/Company information/);
    expect(field('tradingName').value).toBe('Bright ABA');
    expect(field('city').value).toBe('Austin');
    expect(field('postalCode').value).toBe('78701');
    expect(host.textContent).toMatch(/Bright ABA LLC/); // legal name shown read-only
  });

  it('edits and saves only the changed field with the current version (#18/#19)', async () => {
    await mount();
    await waitFor(/Company information/);
    await setField('tradingName', 'Bright ABA Group');
    await setField('websiteUrl', 'https://bright.test');
    await clickButton(/Save changes/);
    await waitFor(/Company profile saved/);
    expect(updateOrganizationProfile).toHaveBeenCalledTimes(1);
    const [patch, version] = updateOrganizationProfile.mock.calls[0];
    expect(patch).toEqual({ tradingName: 'Bright ABA Group', websiteUrl: 'https://bright.test' });
    expect(version).toBe(4);
  });

  it('sends null to clear a previously-set clearable field', async () => {
    await mount();
    await waitFor(/Company information/);
    await setField('addressLine1', ''); // was "12 Oak St"
    await clickButton(/Save changes/);
    await waitFor(/Company profile saved/);
    expect(updateOrganizationProfile.mock.calls[0][0]).toEqual({ addressLine1: null });
  });

  it('does not call the API when nothing changed (respects min-one-field rule)', async () => {
    await mount();
    await waitFor(/Company information/);
    await clickButton(/Save changes/);
    await waitFor(/No changes to save/);
    expect(updateOrganizationProfile).not.toHaveBeenCalled();
  });

  it('blocks save and shows an error when a required field is emptied', async () => {
    await mount();
    await waitFor(/Company information/);
    await setField('tradingName', '');
    await clickButton(/Save changes/);
    await settle();
    expect(updateOrganizationProfile).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/required/i);
  });

  it('does not crash on an unexpected/empty API shape (#39)', async () => {
    getOrganizationProfile.mockResolvedValue({}); // malformed: no fields
    await mount();
    await waitFor(/Company information/);
    // Fields degrade to empty strings rather than throwing.
    expect(field('tradingName').value).toBe('');
    expect(field('city').value).toBe('');
  });

  it('shows the primary (login) email locked and never offers it as an editable field (#24)', async () => {
    await mount();
    await waitFor(/Company information/);
    // The primary email is displayed in a read-only, disabled input...
    const locked = host.querySelector('input[aria-label="Primary email (locked)"]');
    expect(locked).not.toBeNull();
    expect(locked.value).toBe('dana@bright.test');
    expect(locked.disabled).toBe(true);
    expect(host.textContent).toMatch(/Locked/);
    // ...but there is NO editable named input for it, and the contact email is separate.
    expect(field('primaryContactEmail')).toBeNull();
    expect(field('contactEmail').value).toBe('hello@bright.test');
  });

  it('never includes the primary email in the update payload (#25)', async () => {
    await mount();
    await waitFor(/Company information/);
    await setField('contactEmail', 'newpublic@bright.test');
    await clickButton(/Save changes/);
    await waitFor(/Company profile saved/);
    const [patch] = updateOrganizationProfile.mock.calls[0];
    expect(patch).toEqual({ contactEmail: 'newpublic@bright.test' });
    expect(patch).not.toHaveProperty('primaryContactEmail');
  });

  it('brands the profile as Abstract ABA and shows the platform provider and support contact', async () => {
    await mount();
    await waitFor(/Company information/);
    expect(host.textContent).toMatch(/How your company appears across Abstract ABA\./);
    expect(host.textContent).not.toMatch(/ABA1ON1/);
    const support = [...host.querySelectorAll('.rx-cpf__support')][0];
    expect(support).toBeTruthy();
    expect(support.textContent).toMatch(/Support/);
    expect(support.textContent).toMatch(/Platform provider\s*WebieApp Solutions LLC/);
    expect(support.textContent).toMatch(/Contact Abstract ABA at info@abstractaba\.com/);
    expect(support.textContent).toMatch(/Platform provided by WebieApp Solutions LLC/);
    const links = [...support.querySelectorAll('a[href="mailto:info@abstractaba.com"]')];
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.textContent === 'info@abstractaba.com')).toBe(true);
    // The customer's own identity is untouched.
    expect(host.textContent).toMatch(/Bright ABA LLC/);
  });

  it('renders the consolidated Branding and Account security sections (#29/#31)', async () => {
    await mount();
    await waitFor(/Company information/);
    expect(host.textContent).toMatch(/Branding/);
    expect(host.textContent).toMatch(/Account security/);
    expect(host.querySelector('#cp-current')).not.toBeNull(); // change-password fields
    expect(host.querySelector('#cp-new')).not.toBeNull();
  });

  it('uses the Staff / Client page header and the grouped sections in order', async () => {
    await mount();
    await waitFor(/Company information/);
    expect(host.querySelector('.rx-st__head h1.rx-st__title').textContent).toBe('Company Profile');
    expect([...host.querySelectorAll('.rx-sf__section-title')].map((h) => h.textContent)).toEqual([
      'Company information', 'Company settings', 'Contact information', 'Address', 'Operating states', 'Account security',
    ]);
    const sectionFields = (title) => {
      const sec = [...host.querySelectorAll('.rx-sf__section')].find((x) => x.querySelector('.rx-sf__section-title').textContent === title);
      return [...sec.querySelectorAll('input[name]')].map((i) => i.name);
    };
    expect(sectionFields('Company information')).toEqual(['tradingName', 'websiteUrl']);
    expect(sectionFields('Contact information')).toEqual(['primaryContactName', 'contactEmail', 'contactPhone']);
    expect(sectionFields('Address')).toEqual(['addressLine1', 'addressLine2', 'city', 'postalCode']);
    // Two-column field grid; long address lines span the full row.
    expect(field('addressLine1').closest('.rx-cpf__full')).not.toBeNull();
    expect(field('city').closest('.rx-cpf__full')).toBeNull();
    expect(field('city').closest('.rx-sf__grid')).not.toBeNull();
  });

  it('organization details show the API values read-only, and "Not set" — never invented values — when absent', async () => {
    getOrganizationProfile.mockResolvedValue({ ...PROFILE, locale: null, stateCode: null });
    await mount();
    await waitFor(/Organization details/);
    const facts = Object.fromEntries([...host.querySelectorAll('.rx-cpf__details .rx-cpf__fact')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
    expect(facts).toEqual({
      Status: 'Active', Workspace: 'bright-aba', Country: 'US', 'Registered state': 'Not set', 'Time zone': 'Central Time — America/Chicago', Locale: 'Not set', 'Operating states': 'TX, OK',
    });
    expect(host.querySelector('#cp-legal').value).toBe('Bright ABA LLC');
    expect(host.querySelector('#cp-legal').disabled).toBe(true);
    expect(host.querySelector('.rx-sf__preview-name').textContent).toBe('Bright ABA');
  });

  it('after save the displayed values update from the API response — no reload', async () => {
    await mount();
    await waitFor(/Company information/);
    await setField('tradingName', 'Bright ABA Group');
    expect(host.textContent).toContain('You have unsaved changes.');
    await clickButton(/Save changes/);
    await waitFor(/Company profile saved/);
    expect(field('tradingName').value).toBe('Bright ABA Group');
    expect(host.querySelector('.rx-sf__preview-name').textContent).toBe('Bright ABA Group');
    expect(host.textContent).toContain('All changes saved.');
  });

  it('discard restores the loaded values without calling the API', async () => {
    await mount();
    await waitFor(/Company information/);
    await setField('city', 'Dallas');
    await clickButton(/Discard changes/);
    expect(field('city').value).toBe('Austin');
    expect(updateOrganizationProfile).not.toHaveBeenCalled();
  });

  it('shows a save error toast and keeps the edits when the API rejects', async () => {
    updateOrganizationProfile.mockRejectedValueOnce(new Error('409'));
    await mount();
    await waitFor(/Company information/);
    await setField('city', 'Dallas');
    await clickButton(/Save changes/);
    await waitFor(/Could not save the company profile/);
    expect(field('city').value).toBe('Dallas');
  });

  it('RBAC: without organization.update the profile is read-only — no Save, no logo upload, inputs disabled', async () => {
    perms.list = ['clients.read'];
    await mount();
    await waitFor(/Company information/);
    expect(host.textContent).toMatch(/Editing requires permission to update the organization/);
    expect([...host.querySelectorAll('button')].some((b) => /Save changes/.test(b.textContent))).toBe(false);
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(field('tradingName').disabled).toBe(true);
    expect(field('tradingName').value).toBe('Bright ABA');
    expect(host.querySelector('#cp-current')).not.toBeNull(); // own password stays available
    host.querySelector('form[aria-label="Company profile"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(updateOrganizationProfile).not.toHaveBeenCalled();
  });

  it('loading shows a skeleton (no empty fields posing as data); an API error shows Retry', async () => {
    let resolve;
    getOrganizationProfile.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await mount();
    await settle();
    expect(host.querySelector('[aria-label="Loading company profile"]')).not.toBeNull();
    expect(field('tradingName')).toBeNull();
    await act(async () => { resolve({ ...PROFILE }); });
    await waitFor(/Company information/);
    act(() => root.unmount()); host.remove(); root = undefined; host = undefined;

    getOrganizationProfile.mockRejectedValueOnce(new Error('boom'));
    await mount();
    await waitFor(/couldn’t load the company profile/);
    await clickButton(/Retry/);
    await waitFor(/Company information/);
    expect(getOrganizationProfile).toHaveBeenCalledTimes(3);
  });
});

/**
 * Company settings → Time zone. The organization timezone is saved through the
 * existing company profile PATCH as an IANA identifier; the session adopts it
 * only after the server confirms, and formatting switches immediately.
 */
describe('CompanyProfileRedesign — organization time zone', () => {
  let useAuthStore; let formatDateTime;
  const trigger = () => host.querySelector('#cp-timezone');
  const openAndPick = async (label) => {
    await act(async () => { trigger().click(); });
    const opt = [...document.querySelectorAll('.rx-select__opt')].find((o) => o.textContent.includes(label));
    await act(async () => { opt.click(); });
  };
  beforeEach(async () => {
    perms.list = ['organization.update']; perms.ready = true;
    consoleErrorSpy = vi.spyOn(console, 'error');
    ({ useAuthStore } = await import('@/auth/store'));
    ({ formatDateTime } = await import('@/lib/format'));
    useAuthStore.setState({ status: 'authenticated', principal: { user: { email: 'dana@bright.test' }, organizationTimezone: 'America/Chicago', permissions: ['organization.update'] } });
    getOrganizationProfile.mockResolvedValue({ ...PROFILE });
    fetchBranding.mockResolvedValue({ logoUrl: null });
    fetchMe.mockResolvedValue({ user: { email: 'dana@bright.test' }, organizationTimezone: 'America/New_York', permissions: ['organization.update'] });
  });
  afterEach(() => {
    if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
    const w = actWarnings(); consoleErrorSpy.mockRestore();
    expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
    useAuthStore.setState({ status: 'unknown', principal: null });
    vi.clearAllMocks();
  });

  it('shows the current time zone with a friendly name and the IANA identifier, and explains its use', async () => {
    await mount();
    await waitFor(/Company settings/);
    expect(trigger().textContent).toContain('Central Time — America/Chicago');
    expect(host.textContent).toContain('Used for dates, schedules, sessions, payroll and billing across your organization.');
    await act(async () => { trigger().click(); });
    expect([...document.querySelectorAll('.rx-select__opt')].map((o) => o.textContent)).toEqual([
      'Eastern Time — America/New_York', 'Central Time — America/Chicago', 'Mountain Time — America/Denver', 'Arizona Time — America/Phoenix',
      'Pacific Time — America/Los_Angeles', 'Alaska Time — America/Anchorage', 'Hawaii Time — Pacific/Honolulu',
    ]);
  });

  it('keeps an organization zone that is not in the list selectable and displayed', async () => {
    getOrganizationProfile.mockResolvedValue({ ...PROFILE, timezone: 'America/Boise' });
    await mount();
    await waitFor(/Company settings/);
    expect(trigger().textContent).toContain('America/Boise');
  });

  it('saves the IANA identifier with the current version; the session switches only after the server confirms (DST-aware formatting)', async () => {
    let resolveSave;
    updateOrganizationProfile.mockImplementation(() => new Promise((r) => { resolveSave = r; }));
    await mount();
    await waitFor(/Company settings/);
    await openAndPick('Eastern Time');
    expect(host.textContent).toContain('You have unsaved changes.');
    await clickButton(/Save changes/);
    await clickButton(/Saving/); // a second click while saving is ignored
    expect(updateOrganizationProfile).toHaveBeenCalledTimes(1);
    expect(updateOrganizationProfile).toHaveBeenCalledWith({ timezone: 'America/New_York' }, 4);

    // Not confirmed yet: the organization timezone has NOT changed.
    expect(useAuthStore.getState().principal.organizationTimezone).toBe('America/Chicago');
    const saveBtn = [...host.querySelectorAll('button')].find((b) => /Saving/.test(b.textContent));
    expect(saveBtn.disabled).toBe(true);
    // 2026-03-08 07:30Z falls inside the DST changeover: New York has already moved to EDT
    // (3:30 AM) while Chicago has not reached its own 2 AM switch (1:30 AM CST) — two hours apart.
    expect(formatDateTime('2026-03-08T07:30:00.000Z')).toContain('1:30 AM');

    await act(async () => { resolveSave({ ...PROFILE, timezone: 'America/New_York', version: 5 }); });
    await waitFor(/Company profile saved/);
    expect(useAuthStore.getState().principal.organizationTimezone).toBe('America/New_York');
    expect(formatDateTime('2026-03-08T07:30:00.000Z')).toContain('3:30 AM');
    expect(fetchMe).toHaveBeenCalled(); // /auth/me re-read after the change
    expect(host.querySelector('#cp-timezone').textContent).toContain('Eastern Time — America/New_York');
    const facts = Object.fromEntries([...host.querySelectorAll('.rx-cpf__details .rx-cpf__fact')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
    expect(facts['Time zone']).toBe('Eastern Time — America/New_York');
  });

  it('a server validation error shows on the field and the session timezone is unchanged', async () => {
    updateOrganizationProfile.mockRejectedValueOnce({ request: {}, response: { status: 422, data: { error: { code: 'VALIDATION_FAILED', details: { fieldErrors: { timezone: ['Choose a valid time zone.'] } } } } } });
    await mount();
    await waitFor(/Company settings/);
    await openAndPick('Mountain Time');
    await clickButton(/Save changes/);
    await waitFor(/Some details are not valid/);
    expect(host.textContent).toContain('Choose a valid time zone.');
    expect(useAuthStore.getState().principal.organizationTimezone).toBe('America/Chicago');
    expect(fetchMe).not.toHaveBeenCalled();
  });

  it('permission and network errors are explained in plain language', async () => {
    updateOrganizationProfile.mockRejectedValueOnce({ request: {}, response: { status: 403, data: {} } });
    await mount();
    await waitFor(/Company settings/);
    await openAndPick('Pacific Time');
    await clickButton(/Save changes/);
    await waitFor(/You don’t have permission to change the company profile/);
    updateOrganizationProfile.mockRejectedValueOnce({ request: {}, message: 'Network Error' });
    await clickButton(/Save changes/);
    await waitFor(/We couldn’t reach the server/);
    expect(useAuthStore.getState().principal.organizationTimezone).toBe('America/Chicago');
  });

  it('without organization.update (BCBA, RBT) the time zone is shown but cannot be changed', async () => {
    perms.list = [];
    await mount();
    await waitFor(/Company settings/);
    expect(trigger().disabled).toBe(true);
    expect(trigger().textContent).toContain('Central Time — America/Chicago');
    expect([...host.querySelectorAll('button')].some((b) => /Save changes/.test(b.textContent))).toBe(false);
  });
});
