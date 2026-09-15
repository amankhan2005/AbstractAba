/**
 * Plain-language Super Admin company actions, derived purely from the company's
 * current backend state. Kept as a pure function (no React, no network) so the
 * activate / deactivate decision logic and its confirmation copy are unit
 * testable without rendering. The component maps each action to a button + the
 * shared ConfirmDialog and to the matching mutation via `via`.
 *
 * Reasons are the operator-facing audit text the backend requires (min 5 chars)
 * for a lifecycle transition. They are never shown to company end users.
 */
export const DEACTIVATE_REASON = 'Deactivated from the console by a platform operator';
export const ACTIVATE_REASON = 'Activated from the console by a platform operator';
export const CLOSE_REASON = 'Company closed from the console by a platform operator';

const ACTIVATE_MESSAGE = 'This will allow the company and its users to access their company panel.';
const DEACTIVATE_MESSAGE =
  'Users from this company will no longer be able to access their company panel until the company is activated again.';

export function companyActions(company) {
  const state = company?.state;
  const name = company?.tradingName || 'this company';
  const actions = [];

  if (state === 'PROVISIONING') {
    actions.push({ key: 'setup', via: 'provision', label: 'Set up', tone: 'secondary' });
  }

  // A company mid-onboarding (before its agreement is on file) can be activated
  // through the onboarding endpoint. After Slice 1 this is rare — onboarding
  // auto-activates — but a console-created company can still land here.
  if (state === 'PENDING_AGREEMENT') {
    actions.push({
      key: 'activate', via: 'onboarding-activate', label: 'Activate Company', tone: 'primary',
      confirm: { title: `Activate ${name}?`, message: ACTIVATE_MESSAGE, confirmLabel: 'Activate Company' },
    });
  }

  if (state === 'ACTIVE') {
    actions.push({
      key: 'deactivate', via: 'transition', toState: 'SUSPENDED', reason: DEACTIVATE_REASON,
      label: 'Deactivate Company', tone: 'danger',
      confirm: { title: `Deactivate ${name}?`, message: DEACTIVATE_MESSAGE, confirmLabel: 'Deactivate Company' },
    });
  }

  if (state === 'SUSPENDED') {
    actions.push({
      key: 'activate', via: 'transition', toState: 'ACTIVE', reason: ACTIVATE_REASON,
      label: 'Activate Company', tone: 'primary',
      confirm: { title: `Activate ${name}?`, message: ACTIVATE_MESSAGE, confirmLabel: 'Activate Company' },
    });
  }

  return actions;
}

/**
 * True when an error from a lifecycle action is an optimistic-concurrency
 * conflict (the company changed since it was read). HTTP 409 or the backend's
 * VERSION_CONFLICT code.
 */
export function isVersionConflict(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  return status === 409 || code === 'VERSION_CONFLICT';
}

export const VERSION_CONFLICT_MESSAGE = 'The company information changed. Please refresh and try again.';

/** Friendly, non-technical message for any failed company action. */
export function actionErrorMessage(err) {
  if (isVersionConflict(err)) return VERSION_CONFLICT_MESSAGE;
  const msg = err?.response?.data?.error?.message;
  return typeof msg === 'string' && msg ? msg : "We couldn't complete that just now. Please try again.";
}

/**
 * Resolve a company's assigned plan against the billing plan catalogue. Pure:
 * given the company and the catalogue array, returns display fields only — never
 * fabricates a plan. `allocatedAt` is surfaced only when the company record
 * actually carries it.
 */
export function resolvePlan(company, plans) {
  const code = company?.planCode ?? null;
  if (!code) return { assigned: false, name: 'No plan assigned', status: null, allocatedAt: null, code: null };
  const plan = Array.isArray(plans) ? plans.find((p) => p.code === code) : null;
  return {
    assigned: true,
    code,
    name: plan?.name ?? code,
    status: plan ? (plan.active ? 'Active' : 'Archived') : null,
    allocatedAt: company?.planAssignedAt ?? company?.planAllocatedAt ?? null,
  };
}
