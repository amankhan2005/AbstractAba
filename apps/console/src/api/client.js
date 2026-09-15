import axios from 'axios';
import { clientEnv } from '@/config/env';

let accessToken = null;

/**
 * REFRESH TOKEN TRANSPORT — hardened httpOnly cookie (blueprint 9.1).
 *
 * The console previously kept the refresh token in localStorage under
 * `aba1on1.console.refresh`. That is worse here than in the tenant app: this is
 * the Super Admin surface, for which the blueprint mandates multi-factor for
 * ALL users and "stricter session limits" (5.4). A thirty-day operator
 * credential readable by any script on the page contradicted both.
 *
 * The API now sets an httpOnly, secure, sameSite, path-scoped cookie and the
 * browser attaches it to /auth/* automatically. Nothing token-shaped is held
 * here. Only a non-sensitive breadcrumb marks that a session may exist, so a
 * cold load can skip a request certain to 401.
 */

const SESSION_HINT_KEY = 'aba1on1.console.session';
const LEGACY_TOKEN_KEY = 'aba1on1.console.refresh';

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function markSessionEstablished() {
  try { window.localStorage.setItem(SESSION_HINT_KEY, '1'); } catch { /* storage unavailable */ }
}

export function clearSessionHint() {
  try { window.localStorage.removeItem(SESSION_HINT_KEY); } catch { /* ignore */ }
  // Purge the real token left behind by earlier builds on upgrade.
  try { window.localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* ignore */ }
}

export function hasRestorableSession() {
  if (accessToken) return true;
  try {
    if (window.localStorage.getItem(SESSION_HINT_KEY) === '1') return true;
    return !!window.localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return false;
  }
}

const API_BASE = clientEnv.VITE_API_BASE_URL || '/api/v1';

const client = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

client.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let refreshPromise = null;

/**
 * Single-flight refresh against the cookie. Concurrent refreshes would each
 * rotate the token and the second would look like a replay, tripping the
 * server's reuse detection and revoking the whole family.
 */
async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE}/auth/refresh`, {}, { withCredentials: true })
      .then((res) => {
        accessToken = res.data.data.accessToken;
        markSessionEstablished();
        return true;
      })
      .catch(() => {
        accessToken = null;
        clearSessionHint();
        return false;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const isAuthRoute = typeof original?.url === 'string' && original.url.includes('/auth/refresh');

    if (error.response?.status === 401 && original && !original._retry && !isAuthRoute) {
      original._retry = true;

      const ok = await refreshAccessToken();

      if (ok) {
        original.headers.Authorization = `Bearer ${accessToken}`;
        return client(original);
      }
    }

    return Promise.reject(error);
  }
);

// ---------------- AUTH ----------------

export async function signIn(email, password) {
  const res = await client.post('/auth/sign-in', { email, password });
  accessToken = res.data.data.accessToken ?? null;
  if (accessToken) markSessionEstablished();
  return res.data.data;
}

/** Restore an operator session from the refresh cookie. */
export async function restoreSession() {
  return refreshAccessToken();
}

export async function fetchMe() {
  return (await client.get('/auth/me')).data.data;
}

export async function signOut() {
  try {
    // No body: the server reads the cookie and clears it.
    await client.post('/auth/sign-out', {});
  } finally {
    accessToken = null;
    clearSessionHint();
  }
}

// ---------------- PLATFORM ----------------

export async function fetchHealth() {
  return (await client.get('/platform/health')).data.data;
}

export async function fetchTenants(params = {}) {
  return (
    await client.get('/platform/organizations', {
      params: { limit: 100, ...params },
    })
  ).data.data;
}

/**
 * The complete company directory. The organizations endpoint is cursor-paged
 * (max 100 per page); this follows `meta.nextCursor` so dashboard counts and the
 * Companies table are never silently capped at the first page. Bounded to 50
 * pages as a runaway guard.
 */
export async function fetchAllTenants(params = {}) {
  const all = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const res = await client.get('/platform/organizations', {
      params: { limit: 100, ...params, ...(cursor ? { cursor } : {}) },
    });
    const rows = res.data?.data;
    if (Array.isArray(rows)) all.push(...rows);
    cursor = res.data?.meta?.nextCursor;
    if (!cursor) break;
  }
  return all;
}

export async function fetchTenant(id) {
  return (
    await client.get(`/platform/organizations/${id}`)
  ).data.data;
}

export async function fetchTenantAudit(id) {
  return (
    await client.get(`/platform/tenants/${id}/audit`, {
      params: { limit: 100 },
    })
  ).data.data;
}

export async function verifyTenantAudit(id) {
  return (
    await client.get(`/platform/tenants/${id}/audit/verify`)
  ).data.data;
}
// ---------------- COMPANY / ORGANIZATION MANAGEMENT ----------------
// All endpoints below already exist on the backend under /api/v1/platform/*
// and are guarded by authenticate + requirePlatformOperator. The Console only
// wires the UI to them — no business logic is duplicated here.

export async function createOrganization(payload) {
  return (await client.post('/platform/organizations', payload)).data.data;
}

// Lifecycle transitions (deactivate = SUSPENDED, reactivate = ACTIVE, close =
// OFFBOARDING) use optimistic concurrency exactly like activate/offboarding:
// the API validates a { toState, reason } body AND requires the version last
// read as an If-Match header. Sending the old `{ target }` shape with no
// If-Match made the console's Deactivate/Activate fail with 422 — this threads
// the real contract through instead.
export async function transitionOrganization(id, body, version) {
  return (
    await client.post(`/platform/organizations/${id}/transitions`, body, ifMatch(version))
  ).data.data;
}

export async function inviteOwner(id, { email, fullName }) {
  return (
    await client.post(`/platform/organizations/${id}/owner-invitations`, { email, fullName })
  ).data.data;
}

export async function listMembers(id, params = {}) {
  return (
    await client.get(`/platform/organizations/${id}/users`, { params: { limit: 100, ...params } })
  ).data.data;
}

export async function resendInvitation(id, invitationId) {
  return (
    await client.post(`/platform/organizations/${id}/owner-invitations/${invitationId}/resend`, {})
  ).data.data;
}

export async function fetchOnboarding(id) {
  return (await client.get(`/platform/organizations/${id}/onboarding`)).data.data;
}

export async function provisionOrganization(id) {
  return (await client.post(`/platform/organizations/${id}/onboarding/provision`, {})).data.data;
}

// activate / offboarding / destruction use optimistic concurrency: the API
// requires the version last read, sent as an If-Match header (a bare integer).
// Omitting it makes requireVersion() reject the request with a 422 — the exact
// cause of the console's activate/offboarding failures. We thread the version
// the caller already holds from the tenant detail.
function ifMatch(version) {
  return version == null ? undefined : { headers: { 'If-Match': String(version) } };
}

export async function activateOrganization(id, version) {
  return (await client.post(`/platform/organizations/${id}/onboarding/activate`, {}, ifMatch(version))).data.data;
}

export async function fetchAgreements(id) {
  return (await client.get(`/platform/organizations/${id}/agreements`)).data.data;
}

export async function beginOffboarding(id, payload, version) {
  return (await client.post(`/platform/organizations/${id}/offboarding`, payload, ifMatch(version))).data.data;
}

export async function fetchLatestExport(id) {
  return (await client.get(`/platform/organizations/${id}/offboarding/export`)).data.data;
}

// ---------------- COMPANY INVITATIONS (operator) ----------------
export async function inviteCompany(payload) {
  return (await client.post('/platform/company-invitations', payload)).data.data;
}

export async function listCompanyInvitations(params = {}) {
  return (await client.get('/platform/company-invitations', { params })).data.data;
}

export async function resendCompanyInvitation(invitationId) {
  return (await client.post(`/platform/company-invitations/${invitationId}/resend`, {})).data.data;
}

export async function revokeCompanyInvitation(invitationId) {
  return (await client.post(`/platform/company-invitations/${invitationId}/revoke`, {})).data.data;
}

// ---------------- ACCOUNT ----------------
export async function changePassword(currentPassword, newPassword) {
  await client.post('/auth/change-password', { currentPassword, newPassword });
  return true;
}

// Public, unauthenticated auth flows (no session, no interceptor). Mirrors the
// tenant web client; the backend endpoints are shared and role-agnostic.
const publicClient = axios.create({ baseURL: API_BASE });
export async function requestPasswordReset(email) {
  // No-enumeration: always resolves regardless of whether the email exists.
  await publicClient.post('/auth/forgot-password', { email });
}
export async function resetPassword(token, newPassword) {
  await publicClient.post('/auth/reset-password', { token, newPassword });
}

// ---------------- BILLING (operator) ----------------
export async function fetchBillingOverview() {
  return (await client.get('/platform/billing/overview')).data.data;
}
export async function fetchPlans() {
  return (await client.get('/platform/billing/plans')).data.data;
}
export async function createPlan(payload) {
  return (await client.post('/platform/billing/plans', payload)).data.data;
}
export async function updatePlan(id, patch) {
  return (await client.patch(`/platform/billing/plans/${id}`, patch)).data.data;
}
export async function fetchInvoices(params = {}) {
  return (await client.get('/platform/billing/invoices', { params })).data.data;
}
export async function voidInvoice(id) {
  return (await client.post(`/platform/billing/invoices/${id}/void`, {})).data.data;
}
export async function recordPayment(payload) {
  return (await client.post('/platform/billing/payments', payload)).data.data;
}
export async function assignSubscription(payload) {
  return (await client.post('/platform/billing/subscriptions', payload)).data.data;
}
export async function fetchOrgSubscription(organizationId) {
  return (await client.get(`/platform/billing/subscriptions/${organizationId}`)).data.data;
}
export async function changeSubscriptionPackage(payload) {
  return (await client.post('/platform/billing/subscriptions/change', payload)).data.data;
}
export async function extendSubscription(id, endDate) {
  return (await client.post(`/platform/billing/subscriptions/${id}/extend`, { endDate })).data.data;
}
export async function updateSubscriptionValidity(id, payload) {
  return (await client.patch(`/platform/billing/subscriptions/${id}/validity`, payload)).data.data;
}

export async function fetchPayments(params = {}) {
  return (await client.get('/platform/billing/payments', { params })).data.data;
}
export async function issueCredit(payload) {
  return (await client.post('/platform/billing/credits', payload)).data.data;
}
export async function fetchCredits(params = {}) {
  return (await client.get('/platform/billing/credits', { params })).data.data;
}

/**
 * Active subscription plans (source of truth for the Plan dropdown). Platform
 * operator only, so this never leaks plan data to tenant users. Returns plan
 * documents with `code` (submitted) and `name` (displayed).
 */
export async function listPlans({ activeOnly = true } = {}) {
  return (
    await client.get('/platform/billing/plans', {
      params: activeOnly ? { active: 'true' } : {},
    })
  ).data.data;
}

/**
 * Insurance master catalog (spec Module 5.1-5.5). Platform-operator CRUD over
 * the global, state-specific insurer catalog that companies pick from. All
 * routes are guarded by requirePlatformOperator on the API.
 */
export async function listInsuranceCatalog({ active } = {}) {
  const params = {};
  if (active === true) params.active = 'true';
  if (active === false) params.active = 'false';
  return (await client.get('/platform/insurance-catalog', { params })).data.data;
}
export async function createInsuranceCatalog(body) {
  return (await client.post('/platform/insurance-catalog', body)).data.data;
}
export async function updateInsuranceCatalog(id, body) {
  return (await client.patch(`/platform/insurance-catalog/${id}`, body)).data.data;
}
export async function deleteInsuranceCatalog(id) {
  return (await client.delete(`/platform/insurance-catalog/${id}`)).data.data;
}
export async function uploadInsuranceCatalogLogo(id, file) {
  // Base64 in a JSON body — the same upload shape the tenant company-logo
  // endpoint uses. The server validates the DECODED bytes (type + size).
  return (await client.post(`/platform/insurance-catalog/${id}/logo`, { file })).data.data;
}

/**
 * Website inquiries ("Contact Us" submissions from the public site). Operators
 * review them and track follow-up status; every route is guarded by
 * requirePlatformOperator on the API.
 */
export async function listInquiries({ status } = {}) {
  return (await client.get('/platform/inquiries', { params: status ? { status } : {} })).data.data;
}
export async function updateInquiry(id, body) {
  return (await client.patch(`/platform/inquiries/${id}`, body)).data.data;
}
