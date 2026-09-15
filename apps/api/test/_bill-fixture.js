import { aggregateGeneratedBill, allocateCents } from '../src/modules/claims/billing.aggregate.js';
import { computeLineAmount } from '../src/modules/payroll/payroll.math.js';

/**
 * A GENERATED insurance bill exactly as ClaimsService.getGeneratedBill returns
 * it, built the way generation persists claim lines: each clinician's charge is
 * (Σ worked minutes ÷ 60) × hourly rate rounded once, then allocated across
 * their sessions. Organization timezone America/New_York. DB-free.
 *
 *   Raymond K  BCBA Test1 J $10/hr 150+150+104 = 404 min → $67.33
 *              RBT  Test2 K $20/hr  90+68      = 158 min → $52.67   client $120.00
 *   Bella B    BCBA Test1 J $10/hr  30+31      =  61 min → $10.17   (BCBA only)
 *   Carl C     RBT  Test2 K $20/hr  20+20+5    =  45 min → $15.00   (RBT only)
 *   Dana D     BCBA Test1 J $10/hr 60 → $10.00, BCBA Test3 L $30/hr 90 → $45.00,
 *              RBT  Test2 K $20/hr 30 → $10.00                      client $65.00
 *   Company total $210.17
 *
 * Names are stored in mixed case on purpose ("test1 j") — the exports must show
 * them the way the page does ("Test1 J").
 */
const STAFF = {
  b1: { _id: 'b1', firstName: 'test1', lastName: 'j' },
  r1: { _id: 'r1', firstName: 'Test2', lastName: 'K' },
  b2: { _id: 'b2', firstName: 'Test3', lastName: 'L' },
};
const CLIENTS = {
  cR: { _id: 'cR', firstName: 'Raymond', lastName: 'K' },
  cB: { _id: 'cB', firstName: 'Bella', lastName: 'B' },
  cC: { _id: 'cC', firstName: 'Carl', lastName: 'C' },
  cD: { _id: 'cD', firstName: 'Dana', lastName: 'D' },
};
const RATE = { b1: 1000, r1: 2000, b2: 3000 };

export const PLAN = [
  { client: 'cR', staff: 'b1', role: 'BCBA', minutes: [150, 150, 104] },
  { client: 'cR', staff: 'r1', role: 'RBT', minutes: [90, 68] },
  { client: 'cB', staff: 'b1', role: 'BCBA', minutes: [30, 31] },
  { client: 'cC', staff: 'r1', role: 'RBT', minutes: [20, 20, 5] },
  { client: 'cD', staff: 'b1', role: 'BCBA', minutes: [60] },
  { client: 'cD', staff: 'b2', role: 'BCBA', minutes: [90] },
  { client: 'cD', staff: 'r1', role: 'RBT', minutes: [30] },
];

export function generatedBillDataset({ plan = PLAN, clients = CLIENTS, staff = STAFF } = {}) {
  const claims = []; const lines = []; const sessions = new Map(); const appts = new Map();
  let n = 0;
  for (const g of plan) {
    let claim = claims.find((c) => c.clientId === g.client);
    if (!claim) {
      claim = { _id: `claim-${g.client}`, claimNumber: `CLM-202609-${String(claims.length + 1).padStart(5, '0')}`, clientId: g.client, payerName: 'Acme Health', status: 'DRAFT', createdAt: new Date('2026-09-15T16:00:00Z') };
      claims.push(claim);
    }
    const total = computeLineAmount({ rateType: 'HOURLY', rateAmount: RATE[g.staff], minutes: g.minutes.reduce((t, m) => t + m, 0) });
    allocateCents(total, g.minutes).forEach((charge, i) => {
      n += 1;
      const startedAt = new Date(Date.UTC(2026, 8, 8 + (n % 6), 13 + (i % 4), 0));
      sessions.set(`s${n}`, { _id: `s${n}`, appointmentId: `a${n}`, status: 'FROZEN', startedAt, endedAt: new Date(startedAt.getTime() + g.minutes[i] * 60000) });
      appts.set(`a${n}`, { _id: `a${n}`, ...(g.role === 'BCBA' ? { bcbaId: g.staff } : g.role === 'RBT' ? { rbtId: g.staff } : {}) });
      lines.push({ claimId: claim._id, sessionId: `s${n}`, staffProfileId: g.staff, serviceDate: startedAt, serviceCode: '97153', charge, authorizationId: 'svc:auth-1', role: g.role, workedMinutes: g.minutes[i], hourlyRate: RATE[g.staff] });
    });
  }
  const agg = aggregateGeneratedBill({
    claims, lines,
    sessionsById: sessions, apptById: appts,
    staffById: new Map(Object.entries(staff)), clientById: new Map(Object.entries(clients)),
    authById: new Map([['svc:auth-1', { id: 'svc:auth-1', authorizationNumber: 'AUTH-9001', billingCode: '97153' }]]),
    timeZone: 'America/New_York',
    window: { start: new Date('2026-09-07T04:00:00Z'), end: new Date('2026-09-15T04:00:00Z') },
  });
  return {
    organization: { name: 'Demo ABA Clinic' },
    period: { label: '09/07/2026 – 09/14/2026', from: '2026-09-07', to: '2026-09-14', timeZone: 'America/New_York' },
    generated: true, persisted: true, generatedAt: new Date('2026-09-15T16:00:00Z'),
    claims: claims.map((c) => ({ id: c._id, claimNumber: c.claimNumber, clientId: c.clientId })),
    ...agg,
  };
}
