import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Spinner, EmptyState, ErrorState } from '../primitives.jsx';
import { itemVariants, gridVariants } from '../motion.js';

/**
 * Premium data table: client-side sort + pagination over already-fetched rows,
 * sticky header, row hover, status badges (via column render), row actions,
 * skeleton loading, empty and error states, and a card-list fallback on mobile.
 *
 * columns: [{ key, header, render?(row), sortable?, width?, align? }]
 * `query` is an optional react-query result to drive loading/error/empty.
 */
export function DataTable({ columns, rows, query, getKey = (r) => r.id, empty, pageSize = 10, onRowClick }) {
  const [sort, setSort] = useState(null); // { key, dir }
  const [page, setPage] = useState(0);

  const data = rows !== undefined ? rows : (query?.data?.items ?? query?.data ?? []);

  const sorted = useMemo(() => {
    if (!sort) return data;
    const col = columns.find((c) => c.key === sort.key);
    const val = col?.sortValue || ((r) => r[sort.key]);
    return [...data].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (sort.dir === 'asc' ? 1 : -1);
    });
  }, [data, sort, columns]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice(page * pageSize, page * pageSize + pageSize);

  if (query?.isLoading) return <TableSkeleton cols={columns.length} />;
  if (query?.isError) return <ErrorState onRetry={() => query.refetch()} />;
  if (data.length === 0) return empty || <EmptyState title="Nothing here yet" />;

  function toggleSort(key) {
    setPage(0);
    setSort((s) => s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' });
  }

  return (
    <div className="rx-table-wrap">
      <table className="rx-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align }}
                className={c.sortable ? 'is-sortable' : ''}
                onClick={c.sortable ? () => toggleSort(c.key) : undefined}>
                {c.header}
                {c.sortable && sort?.key === c.key && <span className="rx-sort">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <motion.tbody variants={gridVariants} initial="initial" animate="animate">
          {pageRows.map((row) => (
            <motion.tr key={getKey(row)} variants={itemVariants}
              className={onRowClick ? 'is-click' : ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align }}>{c.render ? c.render(row) : row[c.key]}</td>
              ))}
            </motion.tr>
          ))}
        </motion.tbody>
      </table>

      {/* Mobile cards */}
      <div className="rx-table-cards">
        {pageRows.map((row) => (
          <div key={getKey(row)} className="rx-tcard" onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {columns.map((c) => (
              <div className="rx-tcard__row" key={c.key}>
                <span className="rx-tcard__k">{c.header}</span>
                <span>{c.render ? c.render(row) : row[c.key]}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {pages > 1 && (
        <div className="rx-pager">
          <button className="rx-btn rx-btn--ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="rx-pager__info">Page {page + 1} of {pages} · {sorted.length} total</span>
          <button className="rx-btn rx-btn--ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function TableSkeleton({ cols }) {
  return (
    <div className="rx-table-wrap">
      <table className="rx-table"><tbody>
        {Array.from({ length: 6 }).map((_, r) => (
          <tr key={r}>{Array.from({ length: cols }).map((__, c) => (
            <td key={c}><div className="rx-skel" style={{ height: 14, width: c === 0 ? '60%' : '80%' }} /></td>
          ))}</tr>
        ))}
      </tbody></table>
    </div>
  );
}

export default DataTable;
