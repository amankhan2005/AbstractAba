import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactMedical, resolveViewer } from '../src/modules/clients/clients.visibility.js';

/**
 * Spec Module 3.5 — RBT MUST NOT see Medical History. The SERVER strips it:
 * an RBT (SELF scope) viewer gets NO history entries at all, and conditions are
 * reduced to a minimal {id,type,label,status} summary (no provider/notes/dates/
 * attachments). Company (ORGANIZATION) and BCBA (TEAM) read the full record.
 */
const ENTRIES = [
  { id: 'm-1', type: 'CONDITION', label: 'ADHD', status: 'ACTIVE', provider: 'Dr. Reed', notes: 'sensitive', onsetDate: new Date('2020-01-01'), attachments: [{ id: 'd-1', title: 'report.pdf' }] },
  { id: 'm-2', type: 'HISTORY', label: 'Seizure 2021', status: 'RESOLVED', provider: 'ER', notes: 'sensitive', onsetDate: new Date('2021-06-01'), attachments: [{ id: 'd-2', title: 'scan.png' }] },
];

test('RBT (SELF) receives NO medical history and only a minimal conditions summary', () => {
  const rbt = resolveViewer({ scope: 'SELF' });
  const out = redactMedical(ENTRIES, rbt);
  assert.equal(out.length, 1, 'history is dropped entirely');
  assert.equal(out[0].type, 'CONDITION');
  assert.deepEqual(Object.keys(out[0]).sort(), ['id', 'label', 'status', 'type']);
  assert.equal('provider' in out[0], false);
  assert.equal('notes' in out[0], false);
  assert.equal('onsetDate' in out[0], false);
  assert.equal('attachments' in out[0], false);
});

test('Company (ORGANIZATION) and BCBA (TEAM) read the full medical record incl. history + attachments', () => {
  for (const scope of ['ORGANIZATION', 'TEAM']) {
    const out = redactMedical(ENTRIES, resolveViewer({ scope }));
    assert.equal(out.length, 2, `${scope} sees conditions AND history`);
    const history = out.find((m) => m.type === 'HISTORY');
    assert.ok(history, `${scope} sees history`);
    assert.ok(Array.isArray(history.attachments), `${scope} sees attachments`);
    assert.equal(history.notes, 'sensitive');
  }
});

test('a null viewer (internal caller) is not restricted', () => {
  const out = redactMedical(ENTRIES, resolveViewer(null));
  assert.equal(out.length, 2);
});
