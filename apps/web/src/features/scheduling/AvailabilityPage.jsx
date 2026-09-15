import { useEffect, useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { formatFullName } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAvailability, listStaff, putAvailability } from '@/api/client';
import { Button, Card, LoadingState, ErrorState, EmptyState } from '@/components';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Manage a staff member's recurring weekly availability. Pick a staff member,
 * add/remove day-and-time windows, and save the whole set (a replace). Requires
 * scheduling.manage; the server enforces the same.
 */
export function AvailabilityPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canManage = permissions.includes('scheduling.manage');
  const queryClient = useQueryClient();

  const [staffId, setStaffId] = useState('');
  const [windows, setWindows] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const staff = useQuery({ queryKey: ['staff', { limit: 100 }], queryFn: () => listStaff({ limit: 100 }) });
  const availability = useQuery({
    queryKey: ['availability', staffId],
    queryFn: () => getAvailability(staffId),
    enabled: Boolean(staffId),
  });

  useEffect(() => {
    if (availability.data) setWindows(availability.data.map((w) => ({ dayOfWeek: w.dayOfWeek, start: minutesToTime(w.startMinute), end: minutesToTime(w.endMinute) })));
  }, [availability.data]);

  const addWindow = () => setWindows((w) => [...w, { dayOfWeek: 1, start: '09:00', end: '17:00' }]);
  const removeWindow = (i) => setWindows((w) => w.filter((_, idx) => idx !== i));
  const setField = (i, key, value) => setWindows((w) => w.map((win, idx) => (idx === i ? { ...win, [key]: value } : win)));

  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const payload = windows.map((w) => ({ dayOfWeek: Number(w.dayOfWeek), startMinute: timeToMinutes(w.start), endMinute: timeToMinutes(w.end) }));
      await putAvailability(staffId, payload);
      await queryClient.invalidateQueries({ queryKey: ['availability', staffId] });
      setSaved(true);
    } catch (err) {
      setError(err?.response?.data?.error?.message ?? 'Could not save availability.');
    }
  };

  return (
    <div className="ui-stack">
      <h1>Availability</h1>
      <Card>
        <label className="field"><span>Staff member</span>
          <select className="input" value={staffId} onChange={(e) => { setStaffId(e.target.value); setSaved(false); }} aria-label="Staff member">
            <option value="">Select…</option>
            {(staff.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{formatFullName(s)}</option>)}
          </select>
        </label>
      </Card>

      {staffId && availability.isLoading ? <LoadingState label="Loading availability…" /> : null}
      {staffId && availability.isError ? <ErrorState message="Could not load availability." onRetry={() => availability.refetch()} /> : null}

      {staffId && availability.isSuccess ? (
        <Card>
          {windows.length === 0 ? <EmptyState message="No windows. Add one below." /> : (
            <table className="table">
              <thead><tr><th>Day</th><th>Start</th><th>End</th>{canManage ? <th /> : null}</tr></thead>
              <tbody>
                {windows.map((w, i) => (
                  <tr key={i}>
                    <td>
                      <select className="input" value={w.dayOfWeek} onChange={(e) => setField(i, 'dayOfWeek', e.target.value)} disabled={!canManage} aria-label="Day">
                        {DAYS.map((d, idx) => <option key={d} value={idx}>{d}</option>)}
                      </select>
                    </td>
                    <td><input className="input" type="time" value={w.start} onChange={(e) => setField(i, 'start', e.target.value)} disabled={!canManage} /></td>
                    <td><input className="input" type="time" value={w.end} onChange={(e) => setField(i, 'end', e.target.value)} disabled={!canManage} /></td>
                    {canManage ? <td><Button variant="ghost" onClick={() => removeWindow(i)}>Remove</Button></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canManage ? (
            <div className="ui-row">
              <Button variant="ghost" onClick={addWindow}>Add window</Button>
              <button type="button" className="ui-button" onClick={save}>Save availability</button>
            </div>
          ) : null}
          {saved ? <p className="muted">Saved.</p> : null}
          {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
