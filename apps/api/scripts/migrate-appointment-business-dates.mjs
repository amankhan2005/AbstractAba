#!/usr/bin/env node
/**
 * ---------------------------------------------------------------------------
 * MIGRATION — re-anchor historical appointments to the organization's business
 * timezone.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until the business-date fix, scheduling/booking.js composed the dates and
 * clock times an admin typed as UTC instants:
 *
 *     '2026-09-12' + '19:00'  ->  2026-09-12T19:00:00.000Z
 *
 * That is only correct for an organization whose business timezone IS UTC. For
 * a New York clinic, a date-only 09/12 booking was persisted at
 * 2026-09-12T00:00:00Z, which is 8pm on 09/11 in New York — so the Start gate
 * (which correctly used the org timezone) reported "Not available for today" on
 * the very day the appointment was scheduled for.
 *
 * New appointments are now composed in the organization timezone and stamped
 * with `businessTimeZone`. This script brings EXISTING rows onto the same
 * footing, so historical appointments keep the business date they were created
 * with rather than silently shifting by the UTC offset.
 *
 * WHAT IT DOES, PER ROW
 * ---------------------
 * It preserves the WALL CLOCK the admin originally typed and re-anchors it to
 * the organization's zone:
 *
 *   TIMED  (timeSet: true)
 *     reads the UTC wall clock that was stored (e.g. 19:00) and re-anchors it
 *     to the same wall clock in the org zone (19:00 New York). The appointment
 *     keeps the date AND time the admin entered.
 *
 *   DATE-ONLY (timeSet: false)
 *     reads the stored UTC calendar date and re-anchors the appointment to that
 *     whole business day: org midnight of that date, through org midnight of
 *     the next day (the exclusive bound).
 *
 * KNOWN, DELIBERATE LIMITATION — READ THIS
 * ----------------------------------------
 * Legacy multi-day bookings CANNOT be fully recovered. The old booking code
 * computed `endDate` and then discarded it on the no-end-time branch, so an
 * appointment booked 09/12 -> 09/14 was persisted with an endAt derived from
 * `units` on 09/12. The end date the admin chose was never written to the
 * database and is not recoverable from the row. This script therefore restores
 * each legacy date-only appointment as a SINGLE business day (its start date),
 * and reports the count separately so you know how many to review. It does not
 * guess. Affected appointments can be re-scheduled through the normal UI, which
 * now stores the full range correctly.
 *
 * SAFETY PROPERTIES
 * -----------------
 *   DRY RUN BY DEFAULT   nothing is written unless you pass --apply.
 *   TENANT-SCOPED        every read and write is filtered by organizationId;
 *                        one tenant can be migrated at a time with --org.
 *   REPEATABLE           rows already carrying `businessTimeZone` are skipped,
 *                        so a re-run is a no-op and an interrupted run can
 *                        simply be restarted. Use --force to re-stamp a tenant
 *                        deliberately (e.g. after correcting org.timezone).
 *   NON-DESTRUCTIVE      the original instants are recorded on the row
 *                        (`legacyStartAt`/`legacyEndAt`) before being replaced,
 *                        so the change is auditable and reversible.
 *   NO SILENT REWRITES   a per-tenant summary and a sample of before/after
 *                        values are printed for review.
 *
 * USAGE
 * -----
 *   node --env-file=.env scripts/migrate-appointment-business-dates.mjs
 *   node --env-file=.env scripts/migrate-appointment-business-dates.mjs --org <id>
 *   node --env-file=.env scripts/migrate-appointment-business-dates.mjs --apply
 *   node --env-file=.env scripts/migrate-appointment-business-dates.mjs --apply --org <id>
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { Organization, Appointment } from '../src/models/index.js';
import { zonedMidnightToUtc, businessDayRange, DAY_MS } from '../src/domain/businessDate.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const ONLY_ORG = (() => {
  const i = args.indexOf('--org');
  return i !== -1 ? args[i + 1] : null;
})();
const SAMPLE_LIMIT = 5;

function fmt(d) {
  return d ? new Date(d).toISOString() : 'null';
}

/** The UTC wall clock that was stored, as {date:'YYYY-MM-DD', minutes:number}. */
function storedWallClock(instant) {
  const d = new Date(instant);
  return {
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/**
 * The corrected instants for one legacy appointment, or null when the row needs
 * no change. Pure, so the dry run and the apply run compute identically.
 */
export function reanchor(appt, timeZone) {
  if (!appt.startAt) return null;
  const timeSet = appt.timeSet ?? true;
  const start = storedWallClock(appt.startAt);

  if (!timeSet) {
    // Whole business day. The end date the admin chose was never persisted (see
    // the limitation above), so this restores the START date as a single day.
    const range = businessDayRange(start.date, start.date, timeZone);
    return range ? { startAt: range.startAt, endAt: range.endAt, recoverable: false } : null;
  }

  const [sy, sm, sd] = start.date.split('-').map(Number);
  const startAt = new Date(zonedMidnightToUtc(sy, sm, sd, timeZone).getTime() + start.minutes * 60000);

  let endAt;
  if (appt.endAt) {
    const end = storedWallClock(appt.endAt);
    const [ey, em, ed] = end.date.split('-').map(Number);
    endAt = new Date(zonedMidnightToUtc(ey, em, ed, timeZone).getTime() + end.minutes * 60000);
    // An end stored at exactly UTC midnight of the following day is the old
    // exclusive-ish bound; keep it strictly after the start.
    if (endAt.getTime() <= startAt.getTime()) endAt = new Date(startAt.getTime() + DAY_MS / 24);
  } else {
    endAt = new Date(startAt.getTime() + DAY_MS / 24);
  }
  return { startAt, endAt, recoverable: true };
}

async function migrateOrganization(org) {
  const timeZone = org.timezone || 'UTC';
  const filter = { organizationId: org._id, deletedAt: null };
  if (!FORCE) filter.businessTimeZone = null;

  const total = await Appointment.countDocuments(filter);
  if (total === 0) {
    console.log(`  ${org.tradingName || org.legalName || org._id} (${timeZone}): nothing to migrate`);
    return { scanned: 0, changed: 0, unchanged: 0, dateOnly: 0 };
  }

  const cursor = Appointment.find(filter).sort({ startAt: 1 }).cursor();
  let scanned = 0; let changed = 0; let unchanged = 0; let dateOnly = 0;
  const samples = [];

  for await (const doc of cursor) {
    scanned += 1;
    const next = reanchor(doc, timeZone);
    if (!next) { unchanged += 1; continue; }
    const shifted = new Date(doc.startAt).getTime() !== next.startAt.getTime()
      || new Date(doc.endAt ?? doc.startAt).getTime() !== next.endAt.getTime();
    if (!next.recoverable) dateOnly += 1;

    if (samples.length < SAMPLE_LIMIT) {
      samples.push(`      ${doc._id}  ${fmt(doc.startAt)} → ${fmt(next.startAt)}   (end ${fmt(doc.endAt)} → ${fmt(next.endAt)})`);
    }

    if (APPLY) {
      // Tenant-scoped write. The legacy instants are preserved on the row, so
      // this migration is auditable and reversible.
      await Appointment.updateOne(
        { _id: doc._id, organizationId: org._id },
        {
          $set: {
            startAt: next.startAt,
            endAt: next.endAt,
            businessTimeZone: timeZone,
            ...(doc.legacyStartAt ? {} : { legacyStartAt: doc.startAt, legacyEndAt: doc.endAt ?? null }),
          },
        },
      );
    }
    if (shifted) changed += 1; else unchanged += 1;
  }

  console.log(`  ${org.tradingName || org.legalName || org._id} (${timeZone}): scanned ${scanned}, re-anchored ${changed}, already correct ${unchanged}`);
  if (dateOnly > 0) {
    console.log(`      ${dateOnly} date-only appointment(s) restored as a SINGLE business day — a legacy multi-day end date was never stored and cannot be recovered. Review and re-schedule these if a range was intended.`);
  }
  if (samples.length) {
    console.log('      sample:');
    for (const line of samples) console.log(line);
  }
  return { scanned, changed, unchanged, dateOnly };
}

async function main() {
  if (process.env.NODE_ENV === 'production' && !APPLY) {
    console.log('Dry run against production. Pass --apply to write.');
  }
  await connectDatabase();

  const orgFilter = ONLY_ORG ? { _id: ONLY_ORG } : {};
  const orgs = await Organization.find(orgFilter).lean();
  if (orgs.length === 0) {
    console.error(ONLY_ORG ? `No organization ${ONLY_ORG}.` : 'No organizations found.');
    await disconnectDatabase();
    process.exitCode = 1;
    return;
  }

  console.log(APPLY ? '\nAPPLYING business-date migration\n' : '\nDRY RUN — no writes. Pass --apply to write.\n');
  const totals = { scanned: 0, changed: 0, unchanged: 0, dateOnly: 0 };
  for (const org of orgs) {
    const r = await migrateOrganization(org);
    totals.scanned += r.scanned;
    totals.changed += r.changed;
    totals.unchanged += r.unchanged;
    totals.dateOnly += r.dateOnly;
  }

  console.log(`\nTotals — scanned ${totals.scanned}, re-anchored ${totals.changed}, already correct ${totals.unchanged}, single-day restorations needing review ${totals.dateOnly}`);
  if (!APPLY) console.log('Nothing was written. Re-run with --apply when the numbers above look right.\n');
  await disconnectDatabase();
}

// Only run when invoked directly, so `reanchor` can be imported by tests.
if (process.argv[1] && process.argv[1].endsWith('migrate-appointment-business-dates.mjs')) {
  main().catch(async (err) => {
    console.error(err);
    try { await disconnectDatabase(); } catch { /* already closed */ }
    process.exitCode = 1;
  });
}

export default main;
export { mongoose };
