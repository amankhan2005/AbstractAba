import axios from 'axios';
import { clientEnv } from '@/config/env';

/**
 * The tenant application's HTTP client. withCredentials sends the httpOnly
 * refresh cookie the API sets; the base URL is the single-origin /api proxy in
 * development and the same path in production. Every success envelope is
 * { data }, unwrapped here so callers work with the payload directly.
 *
 * The short-lived access token lives in this module's memory only — never in
 * localStorage — exactly as the platform console holds it. A single-flight
 * interceptor refreshes once on a 401 and retries the original request.
 */

let accessToken = null;

/**
 * REFRESH TOKEN TRANSPORT — hardened httpOnly cookie (blueprint 9.1).
 *
 * This module used to keep the refresh token in localStorage under
 * `aba1on1.web.refresh`, while carrying `withCredentials: true` and a comment
 * claiming the API set an httpOnly cookie. It did not. The result was a
 * thirty-day credential to a PHI system readable by any script on the page.
 *
 * The API now sets the cookie. The browser attaches it automatically to the
 * auth routes because every request here is credentialed, so this module holds
 * NO refresh token at all — there is nothing here for an attacker to read, and
 * nothing to keep in sync across tabs.
 *
 * "Remember me" still works, and is now stronger: the cookie's own maxAge is
 * the lifetime. What the flag controls is whether the server issues a
 * persistent cookie at all, which is a server decision rather than a client
 * one. The only thing kept locally is a non-sensitive hint that a session may
 * exist, so a cold load can decide whether to attempt a restore without firing
 * a request that is certain to 401.
 */

const SESSION_HINT_KEY = 'aba1on1.web.session';

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

/**
 * Records that a session was established. Carries NO token and no identity —
 * it is a boolean breadcrumb, safe to read and useless to steal.
 */
export function markSessionEstablished() {
  try { window.localStorage.setItem(SESSION_HINT_KEY, '1'); } catch { /* storage unavailable */ }
}

export function clearSessionHint() {
  try { window.localStorage.removeItem(SESSION_HINT_KEY); } catch { /* ignore */ }
  // Remove the legacy token left by earlier builds. Anyone upgrading has a
  // real refresh token sitting in localStorage right now; it must not survive.
  try { window.localStorage.removeItem('aba1on1.web.refresh'); } catch { /* ignore */ }
}

/**
 * Is there anything to restore a session FROM, without making a request?
 *
 * This exists so bootstrap() never fires an unauthenticated GET /v1/auth/me on
 * a cold load — the source of the `401 Unauthorized` that appeared in the
 * console on every page refresh.
 */
export function hasRestorableSession() {
  if (accessToken) return true;
  try {
    if (window.localStorage.getItem(SESSION_HINT_KEY) === '1') return true;
    // A user upgrading from a localStorage build has a session worth restoring.
    return !!window.localStorage.getItem('aba1on1.web.refresh');
  } catch {
    return false;
  }
}

const API_BASE = clientEnv.VITE_API_BASE_URL;

// withCredentials is what carries the httpOnly refresh cookie to /auth/*.
//
// A request timeout is defence-in-depth for the "endless spinner" class of bug:
// the real fix is server-side (a booking write can no longer stall unbounded),
// but a client with NO timeout will spin forever against ANY unresponsive
// upstream. A generous ceiling (well above normal CRUD latency) converts a
// pathological hang into a terminal, surfaced, retryable error — so a mutation
// ALWAYS reaches success or error and the Book-appointment button can never spin
// indefinitely. Long-running endpoints (bulk export/report generation) are still
// comfortably under this bound for ordinary tenants.
const REQUEST_TIMEOUT_MS = 60_000;
const client = axios.create({ baseURL: API_BASE, withCredentials: true, timeout: REQUEST_TIMEOUT_MS });

client.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

let refreshPromise = null;

/**
 * Exchanges the cookie for a fresh access token. Single-flight: several 401s
 * arriving together must produce ONE refresh, because the server rotates the
 * token on every use and treats a replayed token as reuse — concurrent
 * refreshes would revoke the whole family and sign the user out.
 */
async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE}/v1/auth/refresh`, {}, { withCredentials: true })
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
    // Never try to refresh a failed refresh — that is an infinite loop.
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
  },
);

// ---------------- AUTH ----------------

/**
 * Authenticate a tenant user. The refresh token is set by the server as an
 * httpOnly cookie and is deliberately NOT read here.
 */
export async function signIn(email, password) {
  const res = await client.post('/v1/auth/sign-in', { email, password });
  const payload = res.data.data;
  if (payload?.status === 'OK' && payload.accessToken) {
    accessToken = payload.accessToken;
    markSessionEstablished();
  }
  return payload;
}

/** Restore a session from the refresh cookie. True if one was restored. */
export async function restoreSession() {
  return refreshAccessToken();
}

export async function fetchMe() {
  return (await client.get('/v1/auth/me')).data.data;
}

export async function signOut() {
  try {
    // No body: the server reads the cookie and clears it.
    await client.post('/v1/auth/sign-out', {});
  } finally {
    accessToken = null;
    clearSessionHint();
  }
}

// ---------------- THEMING ----------------

export async function fetchResolvedTheme() {
  return (await client.get('/v1/me/theme')).data.data;
}
export async function fetchPreferences() {
  return (await client.get('/v1/me/preferences')).data.data;
}
export async function savePreferences(patch) {
  return (await client.put('/v1/me/preferences', patch)).data.data;
}
export async function resetPreferences() {
  await client.delete('/v1/me/preferences');
}

/**
 * The active tenant's effective settings, grouped by namespace. Values are
 * registry-driven on the server, read here as opaque data.
 */
export async function fetchSettings() {
  return (await client.get('/v1/organization/settings')).data.data;
}

// ---------------- CLIENTS (clinical spine) ----------------

/** Session Insights for the caller's scope — params: { from, to, clientId, staffProfileId, status } (dates YYYY-MM-DD). */
export async function getSessionInsights(params = {}) {
  return (await client.get('/v1/sessions/oversight/insights', { params })).data.data;
}

export async function previewChildBilling(params) {
  // params: { clientId, from, to } — server-computed child+period claim preview.
  return (await client.get('/v1/claims/billing/preview', { params })).data.data;
}
export async function generateChildBilling(payload) {
  // payload: { clientId, from, to } — server groups claimable sessions by
  // authorization and generates claims (idempotent). Returns generated state.
  return (await client.post('/v1/claims/billing/generate', payload)).data.data;
}
export async function downloadChildBillingXlsx(params) {
  const res = await client.get('/v1/claims/billing/export.xlsx', { params, responseType: 'blob' });
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m ? m[1] : 'insurance-billing.xlsx';
  const url = URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return filename;
}

// --- Company-wide Billing (date range only; server finds every client) -----
export async function previewCompanyBilling(params) {
  // params: { from, to } — consolidated company-wide claim preview.
  return (await client.get('/v1/claims/billing/company/preview', { params })).data.data;
}
export async function generateCompanyBilling(payload) {
  // payload: { from, to } — generates all eligible bills across every client in
  // one idempotent operation. Returns the generated company-wide state.
  return (await client.post('/v1/claims/billing/company/generate', payload)).data.data;
}
export async function getGeneratedBill(params) {
  // params: { from, to } — the persisted bill generated for the period, or null.
  return (await client.get('/v1/claims/billing/company/bill', { params })).data.data;
}
export async function listGeneratedBills() {
  // Billing periods with a generated bill, newest first.
  return (await client.get('/v1/claims/billing/company/bills')).data.data;
}
async function downloadBlob(path, params, { fallback, type }) {
  const res = await client.get(path, { params, responseType: 'blob' });
  const cd = res.headers?.['content-disposition'] || '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m ? m[1] : fallback;
  const url = URL.createObjectURL(new Blob([res.data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return filename;
}
export function downloadCompanyBillingXlsx(params) {
  return downloadBlob('/v1/claims/billing/company/export.xlsx', params, { fallback: 'insurance-bill.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
export function downloadCompanyBillingPdf(params) {
  return downloadBlob('/v1/claims/billing/company/export.pdf', params, { fallback: 'insurance-bill.pdf', type: 'application/pdf' });
}

export async function getClientsSummary() {
  // Roster counts within the caller's scope: total, account status, referral stage.
  return (await client.get('/v1/clients/summary')).data.data;
}
export async function listClients(params = {}) {
  const res = await client.get('/v1/clients', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
/**
 * Normalises a "list" payload to a plain array. The clients/authorizations/
 * medical/care-team endpoints return a bare array in `{ data: [...] }`, but a
 * paginated or drifted endpoint may hand back `{ items: [...] }` or a nested
 * `{ data: [...] }`. Centralising the unwrap here keeps the UI free of per-
 * component shape checks (the AuthorizationsPanel `(query.data ?? []).map`
 * crash came from a non-array slipping through) and guarantees `.map`/`.find`
 * always have an array to work on. A truly malformed body degrades to [] — the
 * caller shows an empty state, never a crash.
 */
export function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export async function getClient(clientId) {
  return (await client.get(`/v1/clients/${clientId}`)).data.data;
}
export async function createClient(body) {
  return (await client.post('/v1/clients', body)).data.data;
}
export async function updateClient(clientId, body, version) {
  return (await client.patch(`/v1/clients/${clientId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
// ---- Saved email templates (company-owned, reusable) ----
export async function listEmailTemplates() {
  return (await client.get('/v1/email-templates')).data.data;
}
export async function getEmailTemplate(templateId) {
  return (await client.get(`/v1/email-templates/${templateId}`)).data.data;
}
export async function createEmailTemplate(body) {
  return (await client.post('/v1/email-templates', body)).data.data;
}
export async function updateEmailTemplate(templateId, body, version) {
  return (await client.patch(`/v1/email-templates/${templateId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function deleteEmailTemplate(templateId) {
  return (await client.delete(`/v1/email-templates/${templateId}`)).data.data;
}
export async function fetchParentEmailTemplates(clientId) {
  return (await client.get(`/v1/clients/${clientId}/email-templates`)).data.data;
}
export async function previewParentEmail(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/email-preview`, body)).data.data;
}
export async function sendParentEmail(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/email-send`, body)).data.data;
}
export async function messageCareTeam(clientId, body) {
  // Recipients + sender are resolved server-side; body carries only the message,
  // an optional subject, and an optional narrowing list of member (assignment) ids.
  return (await client.post(`/v1/clients/${clientId}/message-care-team`, body)).data.data;
}
export async function fetchAttentionRoster() {
  return (await client.get('/v1/clients/attention')).data.data;
}
export async function fetchChildAlerts(clientId) {
  return (await client.get(`/v1/clients/${clientId}/alerts`)).data.data;
}
export async function fetchChildProgress(clientId) {
  return (await client.get(`/v1/clients/${clientId}/progress`)).data.data;
}
export async function transitionIntakeStatus(clientId, target, version) {
  return (await client.post(`/v1/clients/${clientId}/intake-status`, { target }, { headers: { 'If-Match': String(version) } })).data.data;
}

// --- FBA/ABA service authorizations (Phase 2, child sub-resource) ----------
// Named *ServiceAuthorization* to avoid colliding with the insurance
// unit-authorization helpers above.
export async function listServiceAuthorizations(clientId) {
  return asList((await client.get(`/v1/clients/${clientId}/authorizations`)).data.data);
}
export async function createServiceAuthorization(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/authorizations`, body)).data.data;
}
export async function updateServiceAuthorization(clientId, authorizationId, body) {
  return (await client.patch(`/v1/clients/${clientId}/authorizations/${authorizationId}`, body)).data.data;
}
export async function transitionServiceAuthorization(clientId, authorizationId, target, reason) {
  return (await client.post(`/v1/clients/${clientId}/authorizations/${authorizationId}/transition`, { target, ...(reason ? { reason } : {}) })).data.data;
}
export async function archiveServiceAuthorization(clientId, authorizationId) {
  return (await client.delete(`/v1/clients/${clientId}/authorizations/${authorizationId}`)).data.data;
}

export async function archiveClient(clientId) {
  return (await client.post(`/v1/clients/${clientId}/archive`, {})).data.data;
}
export async function removeGuardian(clientId, guardianId) {
  // Removes ONLY the guardian relationship from this child; the guardian record
  // and history are preserved server-side.
  return (await client.delete(`/v1/clients/${clientId}/guardians/${guardianId}`)).data.data;
}
export async function addGuardian(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/guardians`, body)).data.data;
}
export async function updateGuardian(clientId, guardianId, body) {
  // Updates the EXISTING guardian relationship in place (no delete+recreate, no
  // duplicate). The server re-checks the parent-activation invariant afterwards.
  return (await client.patch(`/v1/clients/${clientId}/guardians/${guardianId}`, body)).data.data;
}
// --- Company profile (tenant self-service; GET/PATCH /v1/organization) ------
/**
 * The authenticated tenant's own company profile. The server derives the tenant
 * from the session — the browser never supplies an organizationId — so this is
 * always the caller's own company and nothing else. Returns {} on an unexpected
 * empty body so callers can render safely without a crash.
 */
export async function getOrganizationProfile() {
  const data = (await client.get('/v1/organization')).data.data;
  return data ?? {};
}

/**
 * Update the caller's own company profile. Version-guarded with If-Match, the
 * same optimistic-concurrency convention used by updatePlan/updateClient/etc.
 * `patch` carries only the fields the user actually changed.
 */
export async function updateOrganizationProfile(patch, version) {
  return (await client.patch('/v1/organization', patch, { headers: { 'If-Match': String(version) } })).data.data;
}

// --- Company branding (blueprint 6.14 brand tokens) -------------------------
export async function fetchBranding() {
  const data = (await client.get('/v1/organization/branding')).data.data;
  return data ?? {};
}

export async function saveBranding(patch) {
  return (await client.put('/v1/organization/branding', patch)).data.data;
}

/**
 * Logo upload for an ESTABLISHED tenant, distinct from the onboarding-time
 * `uploadCompanyLogo` below.
 *
 * The two differ deliberately. Onboarding has no session yet, so it uses a
 * token-scoped signature and uploads browser-direct. This one has an
 * authenticated principal, so the bytes go through the API: the permission
 * check happens before anything moves, and the resulting URL is written to the
 * brand tokens by code that knows which tenant is asking rather than trusting a
 * URL the browser supplies.
 *
 * Base64 in a JSON body, matching the documents module's upload convention.
 */
export async function uploadTenantLogo(dataUrl) {
  return (await client.post('/v1/organization/branding/logo', { file: dataUrl })).data.data;
}

// --- Guardian invitations (blueprint 2.6 / 6.2) -----------------------------
export async function fetchGuardianInvitations(clientId) {
  const data = (await client.get(`/v1/clients/${clientId}/guardian-invitations`)).data.data;
  return { items: data?.items ?? [] };
}

export async function inviteGuardian(clientId, guardianId) {
  return (await client.post(`/v1/clients/${clientId}/guardians/${guardianId}/invitation`, {})).data.data;
}

export async function resendGuardianInvitation(clientId, invitationId) {
  return (await client.post(`/v1/clients/${clientId}/guardian-invitations/${invitationId}/resend`, {})).data.data;
}

export async function revokeGuardianInvitation(clientId, invitationId) {
  return (await client.delete(`/v1/clients/${clientId}/guardian-invitations/${invitationId}`)).data.data;
}

// The two ANONYMOUS calls. They use the SAME bare `publicClient` the company
// onboarding flow already uses (declared below) rather than the authenticated
// `client`: attaching an Authorization header to a family's one-time link
// would be meaningless at best, and at worst would trip the 401 interceptor
// and bounce a guardian toward a sign-in page for an account they do not have.

// --- Insurance coverage (blueprint 6.2 / 6.9) -------------------------------
// Returns { items, status } — `status` is the single eligibility answer the
// scheduling gate will apply, so the UI can say WHY scheduling is blocked
// rather than surfacing a 422 after the user has already filled in a booking.
export async function fetchCoverage(clientId) {
  const data = (await client.get(`/v1/clients/${clientId}/insurance`)).data.data;
  // Never resolve to undefined — React Query rejects it outright, and "no
  // coverage yet" is an empty list, not a broken query.
  return { items: data?.items ?? [], status: data?.status ?? null };
}

export async function createCoverage(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/insurance`, body)).data.data;
}

export async function updateCoverage(clientId, coverageId, body) {
  return (await client.patch(`/v1/clients/${clientId}/insurance/${coverageId}`, body)).data.data;
}

export async function verifyCoverage(clientId, coverageId, body) {
  return (await client.post(`/v1/clients/${clientId}/insurance/${coverageId}/verification`, body)).data.data;
}

export async function removeCoverage(clientId, coverageId) {
  return (await client.delete(`/v1/clients/${clientId}/insurance/${coverageId}`)).data.data;
}

// Company-facing insurance master catalog (spec Module 5.4): the ACTIVE entries
// available for this company's service states, each with name + logo. Returns []
// (never undefined) so a React Query never rejects.
export async function listInsuranceCatalog() {
  const data = (await client.get('/v1/insurance-catalog')).data.data;
  return Array.isArray(data) ? data : [];
}

export async function listCareTeam(clientId) {
  return asList((await client.get(`/v1/clients/${clientId}/care-team`)).data.data);
}
// medical entries (conditions + history)
export async function listMedical(clientId, params = {}) {
  return asList((await client.get(`/v1/clients/${clientId}/medical`, { params })).data.data);
}
export async function addMedical(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/medical`, body)).data.data;
}
export async function updateMedical(clientId, entryId, body) {
  return (await client.patch(`/v1/clients/${clientId}/medical/${entryId}`, body)).data.data;
}
export async function removeMedical(clientId, entryId) {
  await client.delete(`/v1/clients/${clientId}/medical/${entryId}`);
}
export async function assignCareTeam(clientId, body) {
  return (await client.post(`/v1/clients/${clientId}/care-team`, body)).data.data;
}
export async function removeCareTeam(clientId, assignmentId) {
  await client.delete(`/v1/clients/${clientId}/care-team/${assignmentId}`);
}
export async function updateAssignment(clientId, assignmentId, body) {
  return (await client.patch(`/v1/clients/${clientId}/care-team/${assignmentId}`, body)).data.data;
}
export async function endAssignment(clientId, assignmentId, effectiveEndDate) {
  return (await client.post(`/v1/clients/${clientId}/care-team/${assignmentId}/end`, effectiveEndDate ? { effectiveEndDate } : {})).data.data;
}

// ---------------- STAFF & CREDENTIALS ----------------

export async function listStaff(params = {}) {
  const res = await client.get('/v1/staff', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
export async function getStaff(staffId) {
  return (await client.get(`/v1/staff/${staffId}`)).data.data;
}
export async function createStaff(body) {
  return (await client.post('/v1/staff', body)).data.data;
}
export async function resendStaffLoginEmail(staffId) {
  // Resend the initial login email (before first login only). The admin never
  // sees the password; the response carries only whether delivery was queued.
  return (await client.post(`/v1/staff/${staffId}/resend-login-email`, {})).data.data;
}
export async function updateStaff(staffId, body, version) {
  return (await client.patch(`/v1/staff/${staffId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}

// ---------------- SCHEDULING & CALENDAR ----------------

export async function listAppointments(params = {}) {
  const res = await client.get('/v1/scheduling/appointments', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
export async function getAppointment(appointmentId) {
  return (await client.get(`/v1/scheduling/appointments/${appointmentId}`)).data.data;
}
export async function bookAppointment(body) {
  return (await client.post('/v1/scheduling/appointments', body)).data.data;
}
export async function updateAppointment(appointmentId, body, version) {
  return (await client.patch(`/v1/scheduling/appointments/${appointmentId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function cancelAppointment(appointmentId) {
  return (await client.post(`/v1/scheduling/appointments/${appointmentId}/cancel`, {})).data.data;
}
export async function getAvailability(staffId) {
  return (await client.get(`/v1/scheduling/staff/${staffId}/availability`)).data.data;
}
export async function putAvailability(staffId, windows) {
  return (await client.put(`/v1/scheduling/staff/${staffId}/availability`, { windows })).data.data;
}
export async function listAuthorizations(params = {}) {
  const res = await client.get('/v1/scheduling/authorizations', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
// NOTE: the old scheduling-Authorization create path was retired. All ABA/FBA
// authorization creation now goes through the authoritative ServiceAuthorization
// flow (createServiceAuthorization + the NOT_SENT→SENT→APPROVED workflow), used
// by both the Company child screen and Scheduling's inline create.
export async function updateAuthorization(authorizationId, body, version) {
  return (await client.patch(`/v1/scheduling/authorizations/${authorizationId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}

// Recurring appointment series (Phase 4.3). The server materializes occurrences
// and returns { series, booked, skipped }; the client never supplies
// tenant/status/seriesId or other authoritative fields.
export async function listSeries(params = {}) {
  return (await client.get('/v1/scheduling/series', { params })).data.data;
}
export async function getSeries(seriesId) {
  return (await client.get(`/v1/scheduling/series/${seriesId}`)).data.data;
}
export async function createSeries(body) {
  return (await client.post('/v1/scheduling/series', body)).data.data;
}
export async function cancelSeries(seriesId) {
  return (await client.post(`/v1/scheduling/series/${seriesId}/cancel`, {})).data.data;
}
export async function cancelSeriesOccurrence(seriesId, appointmentId) {
  return (await client.post(`/v1/scheduling/series/${seriesId}/occurrences/${appointmentId}/cancel`, {})).data.data;
}

// ---------------- CLINICAL PLANS ----------------

export async function listPlans(params = {}) {
  const res = await client.get('/v1/plans', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
export async function getPlan(planId) {
  return (await client.get(`/v1/plans/${planId}`)).data.data;
}
export async function createPlan(body) {
  return (await client.post('/v1/plans', body)).data.data;
}
export async function updatePlan(planId, body, version) {
  return (await client.patch(`/v1/plans/${planId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function archivePlan(planId) {
  return (await client.post(`/v1/plans/${planId}/archive`, {})).data.data;
}
export async function deletePlan(planId) {
  return (await client.delete(`/v1/plans/${planId}`)).data.data;
}
export async function addGoal(planId, body) {
  return (await client.post(`/v1/plans/${planId}/goals`, body)).data.data;
}
export async function updateGoal(planId, goalId, body, version) {
  return (await client.patch(`/v1/plans/${planId}/goals/${goalId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function archiveGoal(planId, goalId) {
  return (await client.post(`/v1/plans/${planId}/goals/${goalId}/archive`, {})).data.data;
}
export async function addProgram(planId, goalId, body) {
  return (await client.post(`/v1/plans/${planId}/goals/${goalId}/programs`, body)).data.data;
}
export async function updateProgram(planId, programId, body, version) {
  return (await client.patch(`/v1/plans/${planId}/programs/${programId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function archiveProgram(planId, programId) {
  return (await client.post(`/v1/plans/${planId}/programs/${programId}/archive`, {})).data.data;
}
export async function addTarget(planId, programId, body) {
  return (await client.post(`/v1/plans/${planId}/programs/${programId}/targets`, body)).data.data;
}
export async function updateTarget(planId, programId, targetId, body, version) {
  return (await client.patch(`/v1/plans/${planId}/programs/${programId}/targets/${targetId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function archiveTarget(planId, programId, targetId) {
  return (await client.post(`/v1/plans/${planId}/programs/${programId}/targets/${targetId}/archive`, {})).data.data;
}

// ---------------- SESSION CAPTURE ----------------

export async function listSessions(params = {}) {
  const res = await client.get('/v1/sessions', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
export async function getSession(sessionId) {
  return (await client.get(`/v1/sessions/${sessionId}`)).data.data;
}
export async function createSession(body) {
  return (await client.post('/v1/sessions', body)).data.data;
}
export async function updateSession(sessionId, body, version) {
  return (await client.patch(`/v1/sessions/${sessionId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
// --- Session lifecycle (blueprint Figure 6.2) -------------------------------
// One call per transition, mirroring the API. There is deliberately no
// "setStatus" helper: the backend owns the state machine, and a generic status
// setter on the client would invite the UI to think it owns one too.
export async function clockInSession(sessionId, body = {}) {
  return (await client.post(`/v1/sessions/${sessionId}/clock-in`, body)).data.data;
}

export async function clockOutSession(sessionId, body = {}) {
  return (await client.post(`/v1/sessions/${sessionId}/clock-out`, body)).data.data;
}

export async function getSessionVerification(sessionId) {
  return (await client.get(`/v1/sessions/${sessionId}/verification`)).data.data;
}

export async function captureSessionSignature(sessionId, body) {
  return (await client.post(`/v1/sessions/${sessionId}/signatures`, body)).data.data;
}

/**
 * Submit for review. A dedicated endpoint, not a status PATCH: the server runs
 * the completeness check (§6.6) and refuses with the specific problems to fix.
 */
export async function submitSession(sessionId) {
  return (await client.post(`/v1/sessions/${sessionId}/submit`, {})).data.data;
}

export async function returnSession(sessionId, comment) {
  return (await client.post(`/v1/sessions/${sessionId}/return`, { comment })).data.data;
}

export async function cancelSession(sessionId, body) {
  return (await client.post(`/v1/sessions/${sessionId}/cancel`, body)).data.data;
}

export async function amendSession(sessionId, body) {
  return (await client.post(`/v1/sessions/${sessionId}/amend`, body)).data.data;
}

export async function freezeSession(sessionId) {
  return (await client.post(`/v1/sessions/${sessionId}/freeze`, {})).data.data;
}
export async function addDataPoint(sessionId, body) {
  return (await client.post(`/v1/sessions/${sessionId}/data-points`, body)).data.data;
}
export async function updateDataPoint(sessionId, dataPointId, body, version) {
  const headers = version !== undefined ? { 'If-Match': String(version) } : {};
  return (await client.patch(`/v1/sessions/${sessionId}/data-points/${dataPointId}`, body, { headers })).data.data;
}
export async function removeDataPoint(sessionId, dataPointId) {
  return (await client.delete(`/v1/sessions/${sessionId}/data-points/${dataPointId}`)).data.data;
}

// ---------------- CLINICAL DOCUMENTS ----------------

export async function listDocuments(params = {}) {
  const res = await client.get('/v1/documents', { params });
  return { items: asList(res.data.data), meta: res.data.meta };
}
export async function getDocument(documentId) {
  return (await client.get(`/v1/documents/${documentId}`)).data.data;
}
export async function createDocument(body) {
  return (await client.post('/v1/documents', body)).data.data;
}
export async function updateDocument(documentId, body, version) {
  return (await client.patch(`/v1/documents/${documentId}`, body, { headers: { 'If-Match': String(version) } })).data.data;
}
export async function finalizeDocument(documentId) {
  return (await client.post(`/v1/documents/${documentId}/finalize`, {})).data.data;
}
export async function archiveDocument(documentId) {
  return (await client.post(`/v1/documents/${documentId}/archive`, {})).data.data;
}
export async function supersedeDocument(documentId, body) {
  return (await client.post(`/v1/documents/${documentId}/supersede`, body)).data.data;
}

/**
 * Upload a document's binary artifact. Reads the File as base64 and posts it; the
 * server validates the type/size, computes the checksum, and generates the
 * storageRef (the client never supplies those).
 */
export async function uploadDocumentFile(documentId, file) {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
  return (await client.post(`/v1/documents/${documentId}/file`, {
    fileName: file.name, contentType: file.type || 'application/octet-stream', base64,
  })).data.data;
}

/** Download a document's artifact as a Blob via the authenticated client. */
export async function downloadDocumentFile(documentId) {
  const res = await client.get(`/v1/documents/${documentId}/file`, { responseType: 'blob' });
  return res.data;
}

// ---------------- SUPERVISION (Phase 4.2) ----------------

export async function listSupervisionObservations(params = {}) {
  return (await client.get('/v1/supervision/observations', { params })).data.data;
}
export async function getSupervisionObservation(observationId) {
  return (await client.get(`/v1/supervision/observations/${observationId}`)).data.data;
}
export async function createSupervisionObservation(body) {
  return (await client.post('/v1/supervision/observations', body)).data.data;
}
export async function updateSupervisionObservation(observationId, body) {
  return (await client.patch(`/v1/supervision/observations/${observationId}`, body)).data.data;
}
export async function submitSupervisionObservation(observationId) {
  return (await client.post(`/v1/supervision/observations/${observationId}/submit`, {})).data.data;
}
export async function signSupervisionObservation(observationId) {
  return (await client.post(`/v1/supervision/observations/${observationId}/sign`, {})).data.data;
}
export async function supersedeSupervisionObservation(observationId, body) {
  return (await client.post(`/v1/supervision/observations/${observationId}/supersede`, body)).data.data;
}
export async function recordSupervisionHours(body) {
  return (await client.post('/v1/supervision/hours', body)).data.data;
}
export async function getSupervisionHoursSummary(params = {}) {
  return (await client.get('/v1/supervision/hours', { params })).data.data;
}

// ---------------- ROLE DASHBOARDS ----------------

export async function getCompanyDashboard() {
  // Company Admin dashboard: client/staff distribution, clients requiring
  // attention, authorizations expiring soon, today's sessions, today's BCBA
  // appointment notes and the latest sessions. Tenant, business date and scope
  // are resolved server-side.
  return (await client.get('/v1/dashboards/company')).data.data;
}
export async function getBcbaDashboard(params = {}) {
  return (await client.get('/v1/dashboards/bcba', { params })).data.data;
}
export async function getRbtDashboard(params = {}) {
  return (await client.get('/v1/dashboards/rbt', { params })).data.data;
}

// ---------------- PUBLIC COMPANY ONBOARDING (no auth) ----------------
// These call the public invitation endpoints without the authenticated client,
// so the axios auth/refresh interceptors never run for an un-onboarded visitor.
const publicClient = axios.create({ baseURL: API_BASE });

// The two ANONYMOUS guardian calls. They share `publicClient` with company
// onboarding: attaching an Authorization header to a family's one-time link
// would be meaningless at best, and at worst would trip the 401 interceptor
// and bounce a guardian toward a sign-in page for an account they do not have.
export async function previewMemberInvitation(token) {
  // Anonymous: preview a staff/member invitation before activation.
  return (await publicClient.get(`/v1/invitations/${encodeURIComponent(token)}`)).data.data;
}
export async function acceptMemberInvitation(token, body) {
  // Anonymous: activate the account by setting a password (hashed server-side).
  // Never sends a role — the backend membership role is authoritative.
  return (await publicClient.post(`/v1/invitations/${encodeURIComponent(token)}/accept`, body)).data.data;
}
export async function resolveGuardianInvitation(token) {
  return (await publicClient.get(`/v1/public/guardian/${encodeURIComponent(token)}`)).data.data;
}

export async function submitGuardianInvitation(token, body) {
  return (await publicClient.post(`/v1/public/guardian/${encodeURIComponent(token)}`, body)).data.data;
}

export async function previewCompanyInvitation(token) {
  return (await publicClient.get(`/v1/public/company-invitations/${token}`)).data.data;
}

export async function submitCompanyOnboarding(token, details) {
  // withCredentials so the browser STORES the httpOnly refresh cookie the accept
  // response sets — that cookie is what the auto-login session rotates against.
  return (await publicClient.post(`/v1/public/company-invitations/${token}/accept`, details, { withCredentials: true })).data.data;
}

/**
 * Company logo upload during onboarding. Two hops, neither of which touches
 * our own API with the image bytes:
 *   1. ask our backend for a short-lived signed Cloudinary upload slot
 *      (scoped to this invitation token only)
 *   2. upload the file directly to Cloudinary with that signature
 * Returns Cloudinary's secure_url, which the caller then includes as
 * `logoUrl` in the onboarding submission — the image binary never passes
 * through or is stored on our servers.
 */
export async function uploadCompanyLogo(token, file) {
  const { cloudName, apiKey, timestamp, signature, folder } = (
    await publicClient.post(`/v1/public/company-invitations/${token}/logo-upload-signature`)
  ).data.data;

  const form = new FormData();
  form.append('file', file);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);

  const res = await axios.post(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, form);
  return res.data.secure_url;
}

// Self-serve clinic signup (BR-3). Public, unauthenticated. The server creates
// the organization behind the agreement gate and invites the first owner; the
// clinic is activated only after an operator countersigns.
export async function selfServeSignup(details) {
  return (await publicClient.post('/v1/public/signup', details)).data.data;
}

// ---------------- BILLING (company, tenant-scoped) ----------------
export async function fetchMySubscription() {
  return (await client.get('/v1/billing/subscription')).data.data;
}
export async function fetchMyInvoices() {
  return (await client.get('/v1/billing/invoices')).data.data;
}
export async function fetchMyInvoice(id) {
  return (await client.get(`/v1/billing/invoices/${id}`)).data.data;
}
export async function fetchMyPayments() {
  return (await client.get('/v1/billing/payments')).data.data;
}
export async function fetchMyBalance() {
  return (await client.get('/v1/billing/balance')).data.data;
}

// ---------------- PAYROLL & TIMESHEETS (tenant-scoped) ----------------
export async function fetchPayRates(params = {}) {
  return (await client.get('/v1/payroll/pay-rates', { params })).data.data;
}
export async function createPayRate(payload) {
  return (await client.post('/v1/payroll/pay-rates', payload)).data.data;
}
export async function fetchPayPeriods() {
  return (await client.get('/v1/payroll/pay-periods')).data.data;
}
export async function createPayPeriod(payload) {
  return (await client.post('/v1/payroll/pay-periods', payload)).data.data;
}
export async function fetchTimesheets(params = {}) {
  return (await client.get('/v1/payroll/timesheets', { params })).data.data;
}
export async function openTimesheet(payload) {
  return (await client.post('/v1/payroll/timesheets', payload)).data.data;
}
export async function fetchTimesheet(id) {
  return (await client.get(`/v1/payroll/timesheets/${id}`)).data.data;
}
export async function importTimesheetSessions(id) {
  return (await client.post(`/v1/payroll/timesheets/${id}/import-sessions`, {})).data.data;
}
export async function addTimesheetEntry(id, payload) {
  return (await client.post(`/v1/payroll/timesheets/${id}/entries`, payload)).data.data;
}
export async function removeTimesheetEntry(id, entryId) {
  return (await client.delete(`/v1/payroll/timesheets/${id}/entries/${entryId}`)).data;
}
export async function transitionTimesheet(id, target, reason) {
  return (await client.post(`/v1/payroll/timesheets/${id}/transitions`, { target, reason })).data.data;
}
export async function fetchPayrollRuns(params = {}) {
  return (await client.get('/v1/payroll/runs', { params })).data.data;
}
export async function generatePayrollRun(payPeriodId) {
  return (await client.post('/v1/payroll/runs', { payPeriodId })).data.data;
}
export async function previewPeriodPayroll(params) {
  // params: { mode: 'weekly'|'biweekly'|'custom', from?, to?, anchor? } — the
  // server resolves the completed period and computes payroll; persists nothing.
  return (await client.get('/v1/payroll/period/preview', { params })).data.data;
}
export async function getGeneratedPeriodPayroll(params) {
  // The saved payroll for the period, or null when it has not been generated.
  return (await client.get('/v1/payroll/period/generated', { params })).data.data;
}
export async function generatePeriodPayroll(payload) {
  // payload: { mode, from?, to?, anchor? } — saves the payroll for the period (never twice).
  return (await client.post('/v1/payroll/period/generate', payload)).data.data;
}
export function downloadPeriodPayrollXlsx(params) {
  return downloadBlob('/v1/payroll/period/export.xlsx', params, { fallback: 'payroll.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
export function downloadPeriodPayrollPdf(params) {
  return downloadBlob('/v1/payroll/period/export.pdf', params, { fallback: 'payroll.pdf', type: 'application/pdf' });
}
export async function previewPayrollRun(payPeriodId) {
  // Read-only: computes what a run WOULD pay without persisting anything.
  return (await client.get('/v1/payroll/runs/preview', { params: { payPeriodId } })).data.data;
}
export async function fetchPayrollRun(id) {
  return (await client.get(`/v1/payroll/runs/${id}`)).data.data;
}
export async function transitionPayrollRun(id, target) {
  return (await client.post(`/v1/payroll/runs/${id}/transitions`, { target })).data.data;
}

// ---------------- CLAIMS (tenant-scoped) ----------------
export async function fetchClaims(params = {}) {
  return (await client.get('/v1/claims', { params })).data.data;
}
export async function fetchClaim(id) {
  return (await client.get(`/v1/claims/${id}`)).data.data;
}
export async function generateClaim(payload) {
  return (await client.post('/v1/claims/generate', payload)).data.data;
}
export async function previewClaim(payload) {
  // Read-only: computes the claim from eligible sessions without persisting.
  return (await client.post('/v1/claims/preview', payload)).data.data;
}
export async function submitClaim(id) {
  return (await client.post(`/v1/claims/${id}/submit`, {})).data.data;
}
export async function resubmitClaim(id) {
  return (await client.post(`/v1/claims/${id}/resubmit`, {})).data.data;
}
export async function transitionClaim(id, target, reason) {
  return (await client.post(`/v1/claims/${id}/transitions`, { target, reason })).data.data;
}

// ---------------- ERA / REMITTANCE (tenant-scoped) ----------------
export async function fetchEraFiles(params = {}) {
  return (await client.get('/v1/era/files', { params })).data.data;
}
export async function fetchEraFile(id) {
  return (await client.get(`/v1/era/files/${id}`)).data.data;
}
export async function uploadEraFile(payload) {
  return (await client.post('/v1/era/files', payload)).data.data;
}
export async function fetchEraRecords(params = {}) {
  return (await client.get('/v1/era/records', { params })).data.data;
}
export async function resolveEraRecord(id, claimId) {
  return (await client.post(`/v1/era/records/${id}/resolve`, { claimId })).data.data;
}

// ---------------- FINANCIAL REPORTS (tenant-scoped) ----------------
export async function fetchReportsOverview(params = {}) {
  return (await client.get('/v1/reports/overview', { params })).data.data;
}
export async function fetchRevenueReport(params = {}) {
  return (await client.get('/v1/reports/revenue', { params })).data.data;
}
export async function fetchCollectionsReport(params = {}) {
  return (await client.get('/v1/reports/collections', { params })).data.data;
}
export function reportExportUrl(kind, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return `/v1/reports/export/${kind}${qs ? `?${qs}` : ''}`;
}
export async function downloadReportCsv(kind, params = {}) {
  const res = await client.get(`/v1/reports/export/${kind}`, { params, responseType: 'blob' });
  return res.data;
}
export async function downloadReportXlsx(kind, params = {}) {
  const res = await client.get(`/v1/reports/export/${kind}`, { params: { ...params, format: 'xlsx' }, responseType: 'blob' });
  return res.data;
}

// ---------------- RECONCILIATION (tenant-scoped) ----------------
export async function fetchReconciliationRecords(params = {}) {
  return (await client.get('/v1/reconciliation', { params })).data.data;
}
export async function fetchReconciliationQueue() {
  return (await client.get('/v1/reconciliation/queue')).data.data;
}
export async function refreshReconciliation(payload) {
  return (await client.post('/v1/reconciliation/refresh', payload)).data.data;
}
export async function transitionReconciliation(id, target, extra = {}) {
  return (await client.post(`/v1/reconciliation/${id}/transitions`, { target, ...extra })).data.data;
}

// ---------------- GLOBAL SEARCH (Phase 4.4) ----------------
// Read-only, tenant-scoped, authorized per entity server-side. The client sends
// only the query/filters; the tenant is derived from the session.
export async function globalSearch(params = {}) {
  return (await client.get('/v1/search', { params })).data.data;
}
export async function searchEntity(entityType, params = {}) {
  return (await client.get(`/v1/search/${entityType}`, { params })).data.data;
}

// ---------------- BULK IMPORT / ORG EXPORT (Phase 4.5) ----------------
// CSV is read as base64 and posted; the server validates, scopes to the tenant,
// and never accepts client-supplied tenant/owner/audit fields.
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
export async function previewImport(entity, file) {
  const base64 = await fileToBase64(file);
  return (await client.post(`/v1/bulk/imports/${entity}/preview`, { base64, fileName: file.name })).data.data;
}
export async function commitImport(entity, file) {
  const base64 = await fileToBase64(file);
  return (await client.post(`/v1/bulk/imports/${entity}/commit`, { base64, fileName: file.name })).data.data;
}
export async function listExports() {
  return (await client.get('/v1/bulk/exports')).data.data;
}
export async function generateExport() {
  return (await client.post('/v1/bulk/exports', {})).data.data;
}
export async function downloadExport(exportId) {
  const res = await client.get(`/v1/bulk/exports/${exportId}/download`, { responseType: 'blob' });
  return res.data;
}

export async function changePassword(body) {
  // Authenticated self-service: { currentPassword, newPassword }.
  await client.post('/v1/auth/change-password', body);
}
export async function requestPasswordReset(email) {
  // Public, no-enumeration: always resolves regardless of whether the email exists.
  await publicClient.post('/v1/auth/forgot-password', { email });
}
export async function resetPassword(token, newPassword) {
  // Public: consume a single-use reset token and set a new password.
  await publicClient.post('/v1/auth/reset-password', { token, newPassword });
}
export async function adminResetMemberPassword(membershipId) {
  // Admin-initiated staff reset; the admin never sees or sets the password.
  await client.post(`/v1/users/${membershipId}/reset-password`);
}

// ---------------- BCBA SESSION WORKFLOW ----------------
// The connected appointment → start → persisted timer → stop → ABA/FBA
// selection → memo → payroll pipeline (BCBA panel spec). staffProfileId is
// resolved server-side from the token; the browser never supplies it.

export async function getBcbaPanel(params = {}) {
  return (await client.get('/v1/bcba/panel', { params })).data.data;
}
export async function startBcbaSession(appointmentId) {
  return (await client.post(`/v1/bcba/appointments/${appointmentId}/start`, {})).data.data;
}
export async function getBcbaActiveSession(appointmentId) {
  return (await client.get(`/v1/bcba/appointments/${appointmentId}/session`)).data.data;
}
export async function stopBcbaSession(appointmentId) {
  return (await client.post(`/v1/bcba/appointments/${appointmentId}/stop`, {})).data.data;
}
export async function saveBcbaSessionDocumentation(appointmentId, body) {
  // body: any subset of { what, how, childResponse }. Persists in-session
  // documentation on THIS BCBA's own session; never touches clock/status.
  return (await client.patch(`/v1/bcba/appointments/${appointmentId}/documentation`, body)).data.data;
}
export async function completeBcbaSession(appointmentId, body) {
  // body: { authorizationId, memo? }
  return (await client.post(`/v1/bcba/appointments/${appointmentId}/complete`, body)).data.data;
}
export async function getBcbaTimeRecords(params = {}) {
  return (await client.get('/v1/bcba/time-records', { params })).data.data;
}
export async function getBcbaWeeklyHours() {
  // This BCBA's progress toward the company weekly target (staffProfileId is
  // resolved server-side from the token; the browser never supplies it).
  return (await client.get('/v1/bcba/weekly-hours')).data.data;
}
export async function getBcbaMyHours(period = 'week') {
  // This BCBA's OWN exact worked time (h/m/s) for a period (Change 4). Worked
  // time only — no pay. staffProfileId is resolved server-side from the token;
  // the browser supplies only the period filter.
  return (await client.get('/v1/bcba/my-hours', { params: { period } })).data.data;
}
export async function getBcbaChildDetail(appointmentId) {
  return (await client.get(`/v1/bcba/appointments/${appointmentId}/child`)).data.data;
}

// ---------------- RBT TECHNICIAN PANEL ----------------
// The SAME connected pipeline as the BCBA workflow, served over /v1/rbt/* with
// the appointment's RBT assignment (rbtId). staffProfileId is resolved
// server-side from the token; the browser never supplies it, and never a rate.
export async function getRbtPanel(params = {}) {
  return (await client.get('/v1/rbt/panel', { params })).data.data;
}
export async function startRbtSession(appointmentId) {
  return (await client.post(`/v1/rbt/appointments/${appointmentId}/start`, {})).data.data;
}
export async function getRbtActiveSession(appointmentId) {
  return (await client.get(`/v1/rbt/appointments/${appointmentId}/session`)).data.data;
}
export async function stopRbtSession(appointmentId) {
  return (await client.post(`/v1/rbt/appointments/${appointmentId}/stop`, {})).data.data;
}
export async function saveRbtSessionDocumentation(appointmentId, body) {
  // body: any subset of { what, how, childResponse }. Persists in-session
  // documentation on THIS RBT's own session; never touches clock/status.
  return (await client.patch(`/v1/rbt/appointments/${appointmentId}/documentation`, body)).data.data;
}
export async function createBcbaManualSession(body) {
  // body: { clientId, date: 'YYYY-MM-DD', startTime: 'HH:mm', endTime: 'HH:mm', authorizationIds: [..], memo? }
  // The clinician is resolved from the token; duration is computed server-side.
  return (await client.post('/v1/bcba/manual-session', body)).data.data;
}
export async function createRbtManualSession(body) {
  return (await client.post('/v1/rbt/manual-session', body)).data.data;
}
export async function completeRbtSession(appointmentId, body) {
  // body: { authorizationId, memo? }
  return (await client.post(`/v1/rbt/appointments/${appointmentId}/complete`, body)).data.data;
}
export async function getRbtMyHours(period = 'week') {
  // This RBT's OWN exact worked time (h/m/s) for a period. Worked time only —
  // no pay. staffProfileId is resolved server-side from the token.
  return (await client.get('/v1/rbt/my-hours', { params: { period } })).data.data;
}
export async function getRbtChildDetail(appointmentId) {
  return (await client.get(`/v1/rbt/appointments/${appointmentId}/child`)).data.data;
}

// ---------------- SELF PROFILE (spec §14) ----------------
// Edits the authenticated user's own display name only; email is immutable
// (never sent). Identity is derived server-side from the token.
export async function updateMyProfile(body) {
  // body: { firstName, lastName }
  return (await client.patch('/v1/auth/me', body)).data.data;
}

/**
 * APPOINTMENT NOTES — BCBA planning context for one appointment on one business
 * date. Distinct from the Session Memo, Session Documentation and the
 * Authorization Memo; nothing is copied between them. The server decides who
 * may read and write, so an RBT receives a 403 here rather than an empty note.
 */
export async function getAppointmentNote(appointmentId) {
  // Always the CURRENT business date's note — the server resolves the date.
  return (await client.get(`/v1/scheduling/appointments/${appointmentId}/note`)).data.data;
}
export async function saveAppointmentNote(appointmentId, { note, clientId }) {
  // clientId: the client the BCBA selected, or null when none is selected.
  const body = { note, ...(clientId !== undefined ? { clientId } : {}) };
  return (await client.put(`/v1/scheduling/appointments/${appointmentId}/note`, body)).data.data;
}
export async function deleteAppointmentNote(appointmentId) {
  return (await client.delete(`/v1/scheduling/appointments/${appointmentId}/note`)).data.data;
}
/**
 * The current business date's appointment notes (Company Admin overview): one
 * row per appointment with a note, with the appointment's BCBA/client/RBT and
 * the note's own selected client. No note text — open a row with
 * getAppointmentNote. The server decides which notes the caller may see.
 */
export async function listAppointmentNotesOverview() {
  return (await client.get('/v1/scheduling/appointment-notes')).data.data;
}
