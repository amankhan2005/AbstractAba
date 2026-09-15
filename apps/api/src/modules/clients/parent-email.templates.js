/**
 * Parent/guardian email templates (platform-controlled) + a pure, server-side
 * renderer. Companies may edit the subject/body of an OUTGOING message for a
 * single send ("edit for this send"), but the catalog itself is fixed here — no
 * tenant-supplied HTML, no tenant-defined variables, no arbitrary recipient or
 * sender. The renderer substitutes only an allowlisted set of variables from a
 * resolved context, marks a missing value as "Not available" (never undefined),
 * rejects any unsupported {{token}}, and HTML-escapes every substituted value so
 * edited content cannot inject markup.
 */

/** The only variables that may appear in a parent email. */
export const SUPPORTED_EMAIL_VARIABLES = [
  'childFirstName',
  'parentFirstName',
  'companyName',
  'appointmentDate',
  'appointmentTime',
];

/** Fixed catalog. `editable` fields are subject + body only. */
export const PARENT_EMAIL_TEMPLATES = [
  {
    id: 'child_approved', name: 'Child Approved', category: 'Onboarding',
    description: 'Let a parent know their child has been approved.',
    subject: 'Your child {{childFirstName}} has been approved',
    body: 'Hello {{parentFirstName}},\n\nWe are pleased to let you know that {{childFirstName}} has been approved by {{companyName}}.\n\nWarm regards,\n{{companyName}}',
  },
  {
    id: 'intake_sent', name: 'Intake Sent', category: 'Intake',
    description: 'Notify a parent that intake paperwork has been sent.',
    subject: 'Intake paperwork for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nWe have sent the intake paperwork for {{childFirstName}}. Please complete and return it at your earliest convenience.\n\nThank you,\n{{companyName}}',
  },
  {
    id: 'intake_complete', name: 'Intake Complete', category: 'Intake',
    description: 'Confirm intake is complete.',
    subject: 'Intake complete for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nThank you — intake for {{childFirstName}} is now complete. We will be in touch with next steps.\n\n{{companyName}}',
  },
  {
    id: 'missing_documents', name: 'Missing Documents', category: 'Intake',
    description: 'Request missing intake documents.',
    subject: 'A few documents are still needed for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nTo continue with {{childFirstName}}\u2019s intake, we still need a few documents from you. Please reply to this email or contact our office.\n\nThank you,\n{{companyName}}',
  },
  {
    id: 'insurance_verified', name: 'Insurance Verified', category: 'Insurance',
    description: 'Confirm insurance has been verified.',
    subject: 'Insurance verified for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nGood news — we have verified insurance coverage for {{childFirstName}}.\n\n{{companyName}}',
  },
  {
    id: 'insurance_required', name: 'Insurance Required', category: 'Insurance',
    description: 'Request insurance information.',
    subject: 'Insurance information needed for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nWe need current insurance information for {{childFirstName}} to continue services. Please contact our office at your convenience.\n\n{{companyName}}',
  },
  {
    id: 'bcba_assigned', name: 'BCBA Assigned', category: 'Care team',
    description: 'Announce a BCBA assignment.',
    subject: 'A BCBA has been assigned to {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nA BCBA has been assigned to {{childFirstName}}\u2019s care team. They will reach out to coordinate.\n\n{{companyName}}',
  },
  {
    id: 'rbt_assigned', name: 'RBT Assigned', category: 'Care team',
    description: 'Announce an RBT assignment.',
    subject: 'An RBT has been assigned to {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nAn RBT has been assigned to {{childFirstName}}\u2019s care team.\n\n{{companyName}}',
  },
  {
    id: 'scheduling_notification', name: 'Scheduling Notification', category: 'Scheduling',
    description: 'Share an upcoming appointment.',
    subject: 'Upcoming appointment for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nThis is a reminder of {{childFirstName}}\u2019s appointment on {{appointmentDate}} at {{appointmentTime}}.\n\n{{companyName}}',
  },
  {
    id: 'authorization_update', name: 'Authorization Update', category: 'Authorization',
    description: 'Share an authorization update.',
    subject: 'Authorization update for {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\nWe have an update regarding {{childFirstName}}\u2019s service authorization. Please contact our office for details.\n\n{{companyName}}',
  },
  {
    id: 'custom_admin_message', name: 'Custom Admin Message', category: 'Custom',
    description: 'Compose a custom message; recipient and sender remain resolved server-side.',
    subject: 'A message about {{childFirstName}}',
    body: 'Hello {{parentFirstName}},\n\n\n\n{{companyName}}',
  },
];

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function getParentEmailTemplate(id) {
  return PARENT_EMAIL_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Validate that a string only references supported variables. Returns the list
 * of unsupported tokens found (empty = clean).
 */
export function unsupportedVariablesIn(text) {
  const bad = new Set();
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) {
    if (!SUPPORTED_EMAIL_VARIABLES.includes(m[1])) bad.add(m[1]);
  }
  return [...bad];
}

/**
 * Render one field (subject or body) against a resolved context. Supported
 * variables resolve to their (HTML-escaped) value; a supported-but-missing value
 * renders as "Not available"; unsupported tokens are a validation error the
 * caller must reject before calling (see unsupportedVariablesIn).
 */
function renderField(text, context, { html }) {
  return String(text ?? '').replace(TOKEN_RE, (_full, name) => {
    if (!SUPPORTED_EMAIL_VARIABLES.includes(name)) return 'Not available';
    const raw = context[name];
    const value = raw == null || raw === '' ? 'Not available' : String(raw);
    return html ? escapeHtml(value) : value;
  });
}

/**
 * Render a parent email. Throws { unsupported } if the (possibly edited) subject
 * or body reference variables outside the allowlist — the browser is never the
 * authority. Returns plain-text + html for subject/body plus the variables that
 * resolved vs were unavailable.
 */
export function renderParentEmail({ subject, body }, context = {}) {
  const unsupported = [...new Set([...unsupportedVariablesIn(subject), ...unsupportedVariablesIn(body)])];
  if (unsupported.length > 0) {
    const err = new Error('Unsupported template variables.');
    err.unsupported = unsupported;
    throw err;
  }
  const usedNames = [...new Set([...String(subject ?? '').matchAll(TOKEN_RE)].map((m) => m[1])
    .concat([...String(body ?? '').matchAll(TOKEN_RE)].map((m) => m[1])))];
  const resolved = {};
  const unavailable = [];
  for (const n of usedNames) {
    const v = context[n];
    if (v == null || v === '') unavailable.push(n); else resolved[n] = String(v);
  }
  return {
    subject: renderField(subject, context, { html: false }),
    text: renderField(body, context, { html: false }),
    html: `<div>${renderField(body, context, { html: true }).replace(/\n/g, '<br>')}</div>`,
    resolved,
    unavailable,
  };
}
