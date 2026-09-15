import { useEffect, useState } from 'react';
import { Card } from './Card';

/**
 * A read-only view of the active tenant's effective settings, grouped by
 * namespace — the Phase 1 settings skeleton's client surface. Loading is
 * injected, so the panel renders without a live API and degrades to a clear
 * empty state when settings cannot be fetched. Ported verbatim.
 */
export function SettingsPanel({ load }) {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((data) => { if (!cancelled) { setSettings(data); setStatus('ready'); } })
      .catch(() => { if (!cancelled) setStatus('unavailable'); });
    return () => { cancelled = true; };
  }, [load]);

  return (
    <Card>
      <h2>Organization settings</h2>
      {status === 'loading' && <p>Loading…</p>}
      {status === 'unavailable' && <p>Sign in to an organization to view its settings.</p>}
      {status === 'ready' && settings && (
        <div className="ui-stack">
          {Object.entries(settings).map(([namespace, values]) => (
            <div key={namespace}>
              <h3>{namespace}</h3>
              <dl className="ui-fields">
                {Object.entries(values).map(([key, value]) => (
                  <div className="ui-field" key={key}>
                    <dt>{key}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
