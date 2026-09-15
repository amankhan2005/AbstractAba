import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listDocuments } from '@/api/client';
import { PageHeader, Badge, Icon, DataTable, Toolbar, Select, EmptyState } from '@/ui';
import { formatDate } from '@/lib/format';

/**
 * Documents — a searchable, filterable register. Backend-scoped and read-gated;
 * status/type filters drive the live query. Clean document iconography, premium
 * table with empty/loading/error states.
 */
const STATUS_OPTS = [
  { value: '', label: 'All statuses' }, { value: 'DRAFT', label: 'Draft' },
  { value: 'FINALIZED', label: 'Finalized' }, { value: 'SUPERSEDED', label: 'Superseded' }, { value: 'ARCHIVED', label: 'Archived' },
];
const TYPE_OPTS = [
  { value: '', label: 'All types' }, { value: 'ASSESSMENT', label: 'Assessment' },
  { value: 'TREATMENT_PLAN', label: 'Treatment plan' }, { value: 'PROGRESS_NOTE', label: 'Progress note' }, { value: 'CONSENT', label: 'Consent' },
];

export function DocumentsRedesign() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [documentType, setDocumentType] = useState('');

  const params = {};
  if (search.trim()) params.search = search.trim();
  if (status) params.status = status;
  if (documentType) params.documentType = documentType;
  const query = useQuery({ queryKey: ['documents', params], queryFn: () => listDocuments(params) });

  const columns = [
    { key: 'title', header: 'Document', sortable: true, render: (d) => <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Icon.Doc size={18} /><strong>{d.title || 'Untitled'}</strong></span> },
    { key: 'documentType', header: 'Type', render: (d) => (d.documentType || '—').replace(/_/g, ' ').toLowerCase() },
    { key: 'status', header: 'Status', render: (d) => <Badge status={d.status} /> },
    { key: 'date', header: 'Date', render: (d) => (d.createdAt ? formatDate(d.createdAt) : '—') },
    { key: 'actions', header: '', align: 'right', render: (d) => <button className="rx-btn rx-btn--ghost" onClick={(e) => { e.stopPropagation(); navigate(`/documents/${d.id}`); }}>Open</button> },
  ];

  return (
    <>
      <PageHeader title="Documents" subtitle="Clinical documents across your organization, with status and type." />
      <Toolbar search={search} onSearch={setSearch} placeholder="Search documents by title…">
        <Select value={documentType} onChange={setDocumentType} options={TYPE_OPTS} searchable={false} />
        <Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} />
      </Toolbar>
      <DataTable query={query} columns={columns} onRowClick={(d) => navigate(`/documents/${d.id}`)}
        empty={<EmptyState icon={Icon.Doc} title="No documents yet" body="Documents appear here as they're created." />} />
    </>
  );
}

export default DocumentsRedesign;
