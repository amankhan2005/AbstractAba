/**
 * SESSION OVERSIGHT — child-list aggregation (pure, unit-tested; spec §4). No
 * I/O: the repository supplies the tenant's sessions, a sessionId→workedMinutes
 * map (authoritative SessionTimeRecord), and id→entity maps; this rolls up, per
 * child: the BCBA(s) and RBT(s) who worked, the session count, total worked
 * minutes, and the last session date. Worked time is never derived from a
 * scheduled window. BCBA and RBT are attributed from each session's own
 * appointment assignment, so they never merge.
 */
const nameOf = (id, staffById) => {
  const s = staffById.get(id);
  return s ? ([s.firstName, s.lastName].filter(Boolean).join(' ').trim() || null) : null;
};

export function aggregateOversightChildren({ sessions = [], workedBySession = new Map(), apptById = new Map(), staffById = new Map(), clientById = new Map() }) {
  const byChild = new Map();
  for (const s of sessions) {
    const cid = s.clientId;
    if (!cid) continue;
    if (!byChild.has(cid)) byChild.set(cid, { clientId: cid, sessionCount: 0, workedMinutes: 0, lastSessionAt: null, bcba: new Set(), rbt: new Set() });
    const agg = byChild.get(cid);
    agg.sessionCount += 1;
    const mins = workedBySession.get(s._id ?? s.id);
    agg.workedMinutes += Number.isFinite(mins) ? Math.max(0, Math.round(mins)) : 0;
    const when = s.startedAt ? new Date(s.startedAt) : null;
    if (when && (!agg.lastSessionAt || when > agg.lastSessionAt)) agg.lastSessionAt = when;
    const appt = s.appointmentId ? apptById.get(s.appointmentId) : null;
    if (appt) {
      if (s.staffProfileId && s.staffProfileId === appt.bcbaId) { const n = nameOf(s.staffProfileId, staffById); if (n) agg.bcba.add(n); }
      else if (s.staffProfileId && s.staffProfileId === appt.rbtId) { const n = nameOf(s.staffProfileId, staffById); if (n) agg.rbt.add(n); }
    }
  }

  const rows = [...byChild.values()].map((a) => {
    const c = clientById.get(a.clientId);
    const childName = c ? ((c.preferredName && String(c.preferredName).trim())
      || [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.clientNumber || null) : null;
    return {
      clientId: a.clientId,
      childName,
      bcbaNames: [...a.bcba].sort(),
      rbtNames: [...a.rbt].sort(),
      sessionCount: a.sessionCount,
      workedMinutes: a.workedMinutes,
      lastSessionAt: a.lastSessionAt ? a.lastSessionAt.toISOString() : null,
    };
  });
  rows.sort((x, y) => (x.childName || '').localeCompare(y.childName || ''));
  return rows;
}

/**
 * SESSION INSIGHTS — organization-level aggregation (pure; no I/O).
 *
 * Built from the SAME records the child aggregation uses: the scoped sessions,
 * their authoritative SessionTimeRecords (clock-in/out, worked minutes), their
 * own appointments (BCBA/RBT attribution) and the names of staff and clients.
 * Nothing is estimated: worked time is the time record's persisted minutes,
 * "completed" is an approved/amended session, "in progress" is IN_PROGRESS, and
 * each session is dated on the ORGANIZATION's business calendar.
 *
 * Returns { totals, statusCounts, trend, clinicians, recent, children }.
 */
export const COMPLETED_SESSION_STATUSES = new Set(['FROZEN', 'AMENDED']);

const pad2 = (n) => String(n).padStart(2, '0');
const addDaysKey = (key, days) => {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};
const civilKey = (instant, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))))) / 86400000);
/** Monday-based week start for a civil date. */
const weekStart = (key) => { const [y, m, d] = key.split('-').map(Number); const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return addDaysKey(key, -((dow + 6) % 7)); };

/**
 * Trend buckets across [firstKey, lastKey] (inclusive civil dates): daily up to
 * 45 days, weekly up to 180 days, monthly beyond. Every bucket in the window is
 * present (zero when nothing happened) so the chart never skips a period.
 */
export function trendBuckets(firstKey, lastKey) {
  if (!firstKey || !lastKey || firstKey > lastKey) return { unit: 'day', keys: [] };
  const span = daysBetween(firstKey, lastKey) + 1;
  const keys = [];
  if (span <= 45) {
    for (let k = firstKey; k <= lastKey; k = addDaysKey(k, 1)) keys.push(k);
    return { unit: 'day', keys };
  }
  if (span <= 180) {
    for (let k = weekStart(firstKey); k <= lastKey; k = addDaysKey(k, 7)) keys.push(k);
    return { unit: 'week', keys };
  }
  let [y, m] = firstKey.split('-').map(Number);
  const [ly, lm] = lastKey.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) { keys.push(`${y}-${pad2(m)}-01`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return { unit: 'month', keys };
}
const bucketOf = (key, unit) => (unit === 'day' ? key : unit === 'week' ? weekStart(key) : `${key.slice(0, 7)}-01`);

export function aggregateOversightInsights({
  sessions = [], timeRecs = [], appts = [], staff = [], clients = [], timeZone = 'UTC',
  fromKey = null, toKey = null, todayKey = null, recentLimit = 10,
}) {
  const recBySession = new Map(timeRecs.map((t) => [t.sessionId, t]));
  const apptById = new Map(appts.map((a) => [a._id, a]));
  const staffById = new Map(staff.map((s) => [s._id, s]));
  const clientById = new Map(clients.map((c) => [c._id, c]));
  const childNameOf = (id) => {
    const c = clientById.get(id);
    return c ? ((c.preferredName && String(c.preferredName).trim()) || [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || null) : null;
  };

  const totals = { sessions: 0, completed: 0, inProgress: 0, workedMinutes: 0, bcbaSessions: 0, rbtSessions: 0 };
  const statusCounts = {};
  const clinicians = new Map();
  const enriched = [];
  for (const s of sessions) {
    const rec = recBySession.get(s._id) ?? null;
    const appt = s.appointmentId ? apptById.get(s.appointmentId) : null;
    const role = appt && s.staffProfileId ? (s.staffProfileId === appt.bcbaId ? 'BCBA' : s.staffProfileId === appt.rbtId ? 'RBT' : null) : null;
    const minutes = rec && Number.isFinite(rec.workedMinutes) ? Math.max(0, Math.round(rec.workedMinutes)) : 0;
    const status = String(s.status ?? '').toUpperCase();
    const at = rec?.startedAt ?? s.startedAt ?? null;
    totals.sessions += 1;
    totals.workedMinutes += minutes;
    if (COMPLETED_SESSION_STATUSES.has(status)) totals.completed += 1;
    if (status === 'IN_PROGRESS') totals.inProgress += 1;
    if (role === 'BCBA') totals.bcbaSessions += 1;
    if (role === 'RBT') totals.rbtSessions += 1;
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (s.staffProfileId) {
      const key = `${s.staffProfileId}:${role ?? ''}`;
      if (!clinicians.has(key)) clinicians.set(key, { staffProfileId: s.staffProfileId, name: nameOf(s.staffProfileId, staffById), role, sessions: 0, completed: 0, inProgress: 0, workedMinutes: 0 });
      const c = clinicians.get(key);
      c.sessions += 1; c.workedMinutes += minutes;
      if (COMPLETED_SESSION_STATUSES.has(status)) c.completed += 1;
      if (status === 'IN_PROGRESS') c.inProgress += 1;
    }
    enriched.push({ s, rec, role, minutes, status, at });
  }

  // Trend window: the requested range, or the data's own span up to today.
  const datedKeys = enriched.filter((e) => e.at).map((e) => civilKey(e.at, timeZone)).sort();
  const lastKey = toKey ?? todayKey ?? datedKeys[datedKeys.length - 1] ?? null;
  const firstKey = fromKey ?? datedKeys[0] ?? lastKey;
  const { unit, keys } = trendBuckets(firstKey, lastKey);
  const points = new Map(keys.map((k) => [k, { key: k, sessions: 0, workedMinutes: 0 }]));
  for (const e of enriched) {
    if (!e.at) continue;
    const p = points.get(bucketOf(civilKey(e.at, timeZone), unit));
    if (p) { p.sessions += 1; p.workedMinutes += e.minutes; }
  }

  const recent = enriched
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, recentLimit)
    .map(({ s, rec, role, status }) => ({
      id: s._id,
      clientId: s.clientId,
      childName: childNameOf(s.clientId),
      clinicianName: nameOf(s.staffProfileId, staffById),
      role,
      startedAt: rec?.startedAt ?? s.startedAt ?? null,
      clockIn: rec?.startedAt ?? s.startedAt ?? null,
      clockOut: rec?.endedAt ?? s.endedAt ?? null,
      workedMinutes: rec && Number.isFinite(rec.workedMinutes) ? Math.max(0, Math.round(rec.workedMinutes)) : null,
      status,
      source: s.source ?? null,
    }));

  const children = aggregateOversightChildren({
    sessions,
    workedBySession: new Map(timeRecs.map((t) => [t.sessionId, t.workedMinutes])),
    apptById,
    staffById,
    clientById,
  });

  return {
    range: { from: firstKey, to: lastKey },
    totals,
    statusCounts,
    trend: { unit, points: [...points.values()] },
    clinicians: [...clinicians.values()].sort((a, b) => b.sessions - a.sessions || String(a.name).localeCompare(String(b.name))),
    recent,
    children,
  };
}
