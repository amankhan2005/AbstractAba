import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBcbaPanel, getRbtPanel, listClients, listStaff } from '@/api/client';
import { formatPersonName, formatFullName } from '@/lib/format';

/**
 * ONE place that turns the raw ids the panel API returns (clientId, rbtId) into
 * human names, and that derives the currently-running session. Both the BCBA
 * panel's active-session hero and the shell-wide persistent indicator read from
 * here, so the "never show a database id to the BCBA" rule (spec §A/§B) lives in
 * a single spot instead of being re-implemented per surface.
 *
 * A missing name never falls back to the id — it falls back to a neutral human
 * word ("Child", "Assigned RBT", "None"), so a not-yet-loaded or out-of-scope
 * record still reads like an app, never like a database.
 */
/** The server's maximum page size for the client and staff list endpoints. */
const MAX_NAME_PAGE = 100;

export function useBcbaNames() {
  // 100 is the server's maximum page size for these list endpoints. Asking for
  // 200 was rejected with a 422, so BOTH name lookups failed and every name fell
  // back to the neutral placeholder — the panel showed "Child" instead of the
  // client's name, with nothing on screen to explain why. The cap is a
  // deliberate server bound, so the client respects it rather than raising it.
  const clients = useQuery({ queryKey: ['clients', 'names'], queryFn: () => listClients({ limit: MAX_NAME_PAGE }) });
  const staff = useQuery({ queryKey: ['staff', 'names'], queryFn: () => listStaff({ limit: MAX_NAME_PAGE }) });

  const clientNameById = useMemo(() => {
    const map = new Map();
    for (const c of clients.data?.items ?? []) {
      const name = c.displayName || formatFullName({ firstName: c.firstName, lastName: c.lastName });
      if (name) map.set(c.id, formatPersonName(name));
    }
    return map;
  }, [clients.data]);

  const staffNameById = useMemo(() => {
    const map = new Map();
    for (const s of staff.data?.items ?? []) {
      const name = s.displayName || formatFullName({ firstName: s.firstName, lastName: s.lastName });
      if (name) map.set(s.id, formatPersonName(name));
    }
    return map;
  }, [staff.data]);

  return {
    /** Child display name — never the id. */
    clientName: (id) => (id ? clientNameById.get(id) || 'Child' : 'Child'),
    /** RBT display name — "None" when unassigned, never the id. */
    rbtName: (id) => (id ? staffNameById.get(id) || 'Assigned RBT' : 'None'),
    /** Any staff member's display name (BCBA, RBT, …) — never the id. */
    staffName: (id) => (id ? staffNameById.get(id) || 'Staff member' : '—'),
    ready: !clients.isLoading && !staff.isLoading,
  };
}

/**
 * The single running session across the BCBA's caseload (spec §C/§D). Polls the
 * panel so the persistent indicator stays live while the BCBA moves between
 * pages. Returns the running card (or null) plus the panel query for reuse.
 */
/**
 * Query options shared by BOTH active-session hooks, so the BCBA and RBT panels
 * cannot drift apart in how they revalidate.
 *
 * WHY refetchOnWindowFocus IS FORCED ON HERE. The app-wide default is `false`
 * (App.jsx), which is right for most screens and wrong for this one: with it
 * off, a second tab never re-asks the server, so a clinician who starts a
 * session in Tab A and switches to Tab B sees no active session — and a
 * clinician who STOPS in Tab A sees Tab B offering "Stop session" indefinitely.
 * The session panel is the one place where a stale tab is actively misleading,
 * so it opts in.
 *
 * `staleTime: 0` makes that focus refetch actually fire; the app-wide 15s
 * staleTime would otherwise swallow it. This does NOT poll: the timer keeps
 * counting locally from the persisted anchor, and the server is re-consulted
 * only at real lifecycle moments — tab becomes visible, window regains focus,
 * the page mounts, a reconnect occurs, or a session action completes and
 * invalidates the key.
 *
 * `refetchOnReconnect` is what reconciles after a temporary network loss: the
 * timer never reset and no time was invented while offline, and the moment the
 * connection returns the panel re-reads the authoritative state.
 */
export const ACTIVE_SESSION_QUERY_OPTIONS = {
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  refetchOnMount: true,
  staleTime: 0,
};

export function useBcbaActiveSession({ enabled = true, refetchInterval = false } = {}) {
  const panel = useQuery({
    queryKey: ['bcba', 'panel'],
    queryFn: () => getBcbaPanel(),
    enabled,
    ...ACTIVE_SESSION_QUERY_OPTIONS,
    ...(refetchInterval ? { refetchInterval } : {}),
  });
  const cards = panel.data ?? [];
  const running = cards.find((c) => c.isRunning) ?? null;
  return { panel, cards, running };
}

/**
 * The single running session across the RBT's OWN assignments. Identical shape
 * and semantics to useBcbaActiveSession — same panel-card contract, same
 * server-anchored running card — but reads the RBT panel (/v1/rbt/panel). Used
 * by the persistent ongoing-session bar and the RBT dashboard so both read ONE
 * canonical active session and never start a second one.
 */
export function useRbtActiveSession({ enabled = true, refetchInterval = false } = {}) {
  const panel = useQuery({
    queryKey: ['rbt', 'panel'],
    queryFn: () => getRbtPanel(),
    enabled,
    ...ACTIVE_SESSION_QUERY_OPTIONS,
    ...(refetchInterval ? { refetchInterval } : {}),
  });
  const cards = panel.data ?? [];
  const running = cards.find((c) => c.isRunning) ?? null;
  return { panel, cards, running };
}
