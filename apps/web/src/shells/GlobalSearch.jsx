import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { globalSearch } from '@/api/client';
import { Icon } from '@/ui/icons.jsx';

/**
 * Global topbar search. Talks to the REAL backend (/v1/search via globalSearch),
 * which already enforces tenant + permission + role scope — the frontend sends
 * only the query, never tenant/role/ownership. Debounced, grouped by the real
 * result types the backend returns, keyboard-navigable, with distinct loading /
 * empty / error states. Stale responses can't overwrite newer ones because the
 * React Query key is the debounced term.
 */

// Map a backend result `type` to an icon and the existing route it opens.
const TYPE_META = {
  client: { icon: Icon.Child, label: 'Children', href: (r) => `/clients/${r.id}` },
  staff: { icon: Icon.Users, label: 'Staff', href: (r) => `/staff/${r.id}` },
  document: { icon: Icon.Doc, label: 'Documents', href: () => `/documents` },
};

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const h = setTimeout(() => setV(value), ms); return () => clearTimeout(h); }, [value, ms]);
  return v;
}

function metaLine(r) {
  // Build a short, safe metadata line — never undefined/null.
  const bits = [];
  if (r.clientNumber) bits.push(`#${r.clientNumber}`);
  if (r.discipline) bits.push(r.discipline);
  if (r.payerName) bits.push(r.payerName);
  if (r.documentType) bits.push(r.documentType);
  if (r.status) bits.push(String(r.status).replace(/_/g, ' ').toLowerCase());
  return bits.join(' · ');
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const debounced = useDebounced(term.trim(), 250);

  const query = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => globalSearch({ q: debounced, limit: 5 }),
    enabled: open && debounced.length >= 2,
    retry: false,
    staleTime: 15_000,
  });

  // Flatten the backend groups into an ordered, navigable list (real types only).
  const flat = useMemo(() => {
    const groups = query.data?.groups ?? [];
    const rows = [];
    for (const g of groups) {
      const meta = TYPE_META[g.type];
      if (!meta || !g.items?.length) continue;
      rows.push({ header: meta.label });
      for (const item of g.items) rows.push({ item, meta });
    }
    return rows;
  }, [query.data]);

  const selectable = flat.filter((r) => r.item);
  useEffect(() => { setActive(0); }, [debounced, query.data]);

  // Outside-click and Escape close the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function go(row) {
    if (!row?.item) return;
    const href = row.meta.href(row.item);
    setOpen(false); setTerm('');
    navigate(href);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
    if (!selectable.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, selectable.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(selectable[active]); }
  }

  const showPanel = open && debounced.length >= 2;
  let activeIndex = -1; // running index across selectable rows for highlight

  return (
    <div className="rx-search rx-search--live" ref={rootRef} style={{ position: 'relative' }}>
      <div className="rx-search__field" onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        <Icon.Search size={16} />
        <input
          ref={inputRef}
          className="rx-search__input"
          type="text"
          value={term}
          placeholder="Search everything…"
          aria-label="Search everything"
          onFocus={() => setOpen(true)}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <AnimatePresence>
        {showPanel && (
          <motion.div className="rx-search__panel" role="listbox"
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            {query.isLoading ? (
              <div className="rx-search__state"><span className="rx-spinner rx-spinner--sm" /> Searching…</div>
            ) : query.isError ? (
              <div className="rx-search__state">
                Search is temporarily unavailable.
                <button className="rx-linkbtn" onClick={() => query.refetch()}>Retry</button>
              </div>
            ) : selectable.length === 0 ? (
              <div className="rx-search__state">No results found</div>
            ) : (
              <div className="rx-search__list">
                {flat.map((row, i) => {
                  if (row.header) return <div key={`h-${i}`} className="rx-search__group">{row.header}</div>;
                  activeIndex += 1;
                  const idx = activeIndex;
                  const RowIcon = row.meta.icon;
                  const line = metaLine(row.item);
                  return (
                    <button key={row.item.id || i} type="button"
                      className={`rx-search__result${idx === active ? ' is-active' : ''}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => go(row)}>
                      <span className="rx-search__ico"><RowIcon size={16} /></span>
                      <span className="rx-search__body">
                        <span className="rx-search__label">{row.item.label || 'Untitled'}</span>
                        {line && <span className="rx-search__meta">{line}</span>}
                      </span>
                      <Icon.Arrow size={14} />
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default GlobalSearch;
