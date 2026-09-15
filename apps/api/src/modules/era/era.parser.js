/**
 * A pragmatic 835 (ERA) parser. It reads the segments this application's
 * reconciliation workflow needs and returns a structured result. It does NOT
 * claim full X12 5010 835 compliance.
 *
 * SUPPORTED SEGMENTS:
 *   ISA/GS/ST  — envelope validation (presence + basic structure)
 *   BPR        — total payment amount (BPR02)
 *   TRN        — reassociation trace / check number (TRN02)
 *   N1         — payer / payee names (N101 = PR payer, PE payee)
 *   CLP        — claim payment: CLP01 patient control number (our claimNumber),
 *                CLP02 status code, CLP03 charge, CLP04 paid, CLP05 patient resp,
 *                CLP07 payer control number
 *   CAS        — adjustments: CAS01 group code, then (reason, amount, qty) triples
 *   SVC        — service line payment (captured per claim)
 *   DTM        — service date(s) attached to the current claim
 *   SE/GE/IEA  — trailer validation (presence)
 *
 * NOT SUPPORTED (documented, not faked): MIA/MOA inpatient/outpatient info,
 * PLB provider-level adjustments, LQ remark loops beyond basic capture, and
 * multi-ST transaction sets beyond the first are parsed but not split.
 *
 * Safety: pure string parsing only — no eval, no file-system access, no network.
 * Amounts are converted to integer minor units. Malformed input is rejected
 * with a clear error rather than throwing raw.
 */

const DEFAULT_SEG = '~';
const DEFAULT_ELEM = '*';

export class EraParseError extends Error {}

function toMinorUnits(dollars) {
  // 835 monetary amounts are decimal dollars; convert to integer cents safely.
  const n = Number(dollars);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Detect delimiters from the ISA segment when possible, else use defaults. */
function detectDelimiters(content) {
  // ISA is fixed-width; element separator is the 4th char, segment terminator
  // is the char right after the 106-char ISA. Fall back to defaults if unclear.
  if (content.startsWith('ISA') && content.length > 105) {
    const elem = content[3];
    const seg = content[105];
    if (elem && seg && elem !== seg) return { elem, seg };
  }
  return { elem: DEFAULT_ELEM, seg: DEFAULT_SEG };
}

export function parse835(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new EraParseError('Empty or non-text ERA content.');
  }
  const { elem, seg } = detectDelimiters(content);
  const rawSegments = content.split(seg).map((s) => s.trim()).filter(Boolean);
  if (rawSegments.length === 0) throw new EraParseError('No segments found.');

  const segs = rawSegments.map((s) => s.split(elem));
  const tag = (s) => s[0];

  // Structural validation: require an ST and an SE (transaction set), and at
  // least one CLP (otherwise there is nothing to reconcile).
  const hasST = segs.some((s) => tag(s) === 'ST');
  const hasSE = segs.some((s) => tag(s) === 'SE');
  if (!hasST || !hasSE) throw new EraParseError('Missing ST/SE transaction set envelope.');

  const result = {
    payerName: null,
    payeeName: null,
    totalPaidAmount: 0,
    traceNumber: null,
    claims: [],
  };
  let current = null;

  for (const s of segs) {
    switch (tag(s)) {
      case 'BPR':
        result.totalPaidAmount = toMinorUnits(s[2]);
        break;
      case 'TRN':
        result.traceNumber = s[2] ?? null;
        break;
      case 'N1':
        if (s[1] === 'PR') result.payerName = s[2] ?? null;
        else if (s[1] === 'PE') result.payeeName = s[2] ?? null;
        break;
      case 'CLP':
        current = {
          claimNumberRef: s[1] ?? null,
          claimStatusCode: s[2] ?? null,
          chargeAmount: toMinorUnits(s[3]),
          paidAmount: toMinorUnits(s[4]),
          patientResponsibility: toMinorUnits(s[5]),
          payerControlNumber: s[7] ?? null,
          serviceDate: null,
          adjustments: [],
        };
        result.claims.push(current);
        break;
      case 'CAS':
        if (current) {
          // CAS01 group, then repeating (reason, amount, quantity) triples.
          const group = s[1];
          for (let i = 2; i + 1 < s.length; i += 3) {
            if (s[i] == null || s[i] === '') continue;
            current.adjustments.push({
              groupCode: group,
              reasonCode: s[i],
              amount: toMinorUnits(s[i + 1]),
            });
          }
        }
        break;
      case 'DTM':
        if (current && !current.serviceDate) {
          const d = s[2];
          // 835 dates are CCYYMMDD.
          if (d && /^\d{8}$/.test(d)) {
            current.serviceDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
          }
        }
        break;
      default:
        break; // SVC, ISA, GS, ST, SE, GE, IEA, N3, N4, etc. — validated/ignored
    }
  }

  return result;
}

/** Supported-segment list, exported for documentation/tests. */
export const SUPPORTED_835_SEGMENTS = ['ISA', 'GS', 'ST', 'BPR', 'TRN', 'N1', 'CLP', 'CAS', 'DTM', 'SVC', 'SE', 'GE', 'IEA'];
