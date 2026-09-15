import crypto from 'node:crypto';
import { AppError } from '../../common/errors/AppError.js';

export const INQUIRY_NOTIFY_TEAM_JOB = 'inquiry.notify_team';
export const INQUIRY_CONFIRM_SUBMITTER_JOB = 'inquiry.confirm_submitter';
export const PLATFORM_AUDIT_TENANT = '__platform__';

/** A resubmission of the same inquiry inside this window is treated as a double submit. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Public website inquiries ("Contact Us").
 *
 *  - submit(): public and anonymous. Persists the inquiry, then enqueues two
 *    email deliveries on the existing job queue: a notification to the Abstract
 *    ABA team and a confirmation to the submitter. Delivery retries happen in
 *    the job worker and never fail the visitor's submission. A honeypot hit or
 *    an accidental duplicate returns the same receipt without storing or
 *    emailing again, so bots and double-clicks learn nothing.
 *  - list() / get() / update(): platform operators only (enforced by the
 *    router). Status changes stamp contactedAt / closedAt and are recorded on
 *    the platform audit chain as metadata only, never the message text.
 */
export class InquiryService {
  constructor(deps) {
    // { repository, jobQueue, audit?, clock? }
    this.deps = deps;
  }

  now() {
    return this.deps.clock?.now?.() ?? new Date();
  }

  static submissionKey({ email, subject, message }) {
    const normalized = [email, subject, message].map((v) => String(v ?? '').trim().toLowerCase()).join('|');
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  async submit(input) {
    const receipt = { received: true };
    // Honeypot: a bot filled the hidden field. Answer normally, store nothing.
    if (typeof input.website === 'string' && input.website.trim() !== '') return receipt;

    const submissionKey = InquiryService.submissionKey(input);
    const since = new Date(this.now().getTime() - DUPLICATE_WINDOW_MS);
    if (await this.deps.repository.findRecentDuplicate(submissionKey, since)) return receipt;

    const created = await this.deps.repository.create({
      name: input.name,
      organization: input.organization,
      email: input.email,
      phone: input.phone ?? null,
      subject: input.subject,
      message: input.message,
      status: 'NEW',
      submissionKey,
    });

    await this.deps.jobQueue.enqueue({
      type: INQUIRY_NOTIFY_TEAM_JOB,
      tenantId: null,
      payload: {
        inquiryId: created.id,
        name: created.name,
        organization: created.organization,
        email: created.email,
        phone: created.phone,
        subject: created.subject,
        message: created.message,
        submittedAt: created.createdAt,
      },
      idempotencyKey: `inquiry-team:${created.id}`,
    });
    await this.deps.jobQueue.enqueue({
      type: INQUIRY_CONFIRM_SUBMITTER_JOB,
      tenantId: null,
      payload: { inquiryId: created.id, name: created.name, email: created.email, subject: created.subject },
      idempotencyKey: `inquiry-confirm:${created.id}`,
    });
    await this._audit(null, 'inquiry.received', created.id, { status: 'NEW' });
    return receipt;
  }

  async list({ status } = {}) {
    const [items, counts] = await Promise.all([
      this.deps.repository.list({ status }),
      this.deps.repository.countByStatus(),
    ]);
    return {
      items,
      counts: { NEW: counts.NEW ?? 0, CONTACTED: counts.CONTACTED ?? 0, CLOSED: counts.CLOSED ?? 0 },
    };
  }

  async get(id) {
    const inquiry = await this.deps.repository.findById(id);
    if (!inquiry) throw AppError.notFound('INQUIRY_NOT_FOUND', 'Inquiry not found.');
    return inquiry;
  }

  async update({ id, actorUserId, input }) {
    const before = await this.get(id);
    const at = this.now();
    const patch = {};

    if (input.status !== undefined && input.status !== before.status) {
      patch.status = input.status;
      if (input.status === 'CONTACTED') {
        patch.contactedAt = before.contactedAt ?? at;
        patch.contactedBy = actorUserId;
        patch.closedAt = null;
        patch.closedBy = null;
      } else if (input.status === 'CLOSED') {
        patch.closedAt = at;
        patch.closedBy = actorUserId;
      } else if (input.status === 'NEW') {
        patch.closedAt = null;
        patch.closedBy = null;
      }
    }

    let noteChanged = false;
    if (input.internalNote !== undefined) {
      const note = typeof input.internalNote === 'string' && input.internalNote.trim() ? input.internalNote.trim() : null;
      if (note !== (before.internalNote ?? null)) {
        patch.internalNote = note;
        noteChanged = true;
      }
    }

    if (Object.keys(patch).length === 0) return before;
    const updated = await this.deps.repository.update(id, patch);
    if (patch.status) {
      await this._audit(actorUserId, 'inquiry.status_changed', id, { before: before.status, after: patch.status });
    }
    if (noteChanged) await this._audit(actorUserId, 'inquiry.note_updated', id, {});
    return updated;
  }

  async _audit(actorUserId, action, entityId, payload) {
    if (!this.deps.audit?.record) return;
    try {
      await this.deps.audit.record({
        tenantId: PLATFORM_AUDIT_TENANT,
        actorId: actorUserId ?? null,
        action,
        entityType: 'inquiry',
        entityId,
        outcome: 'success',
        payload: payload ?? {},
      });
    } catch {
      // An audit append must never break the request.
    }
  }
}
