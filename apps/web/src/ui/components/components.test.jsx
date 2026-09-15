import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Select } from './Select.jsx';
import { DataTable } from './DataTable.jsx';

/**
 * Component tests for the new premium primitives. Every state update is wrapped
 * in act(), which is exactly how React test warnings ("update … not wrapped in
 * act(...)") are avoided — the updates are awaited rather than silenced.
 */
let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const OPTS = [
  { value: 'a', label: 'Alice Johnson' },
  { value: 'b', label: 'Bob Smith' },
  { value: 'c', label: 'Carol White' },
];

describe('Select', () => {
  it('shows the placeholder when nothing is selected and opens on click', () => {
    act(() => root.render(<Select value="" onChange={() => {}} options={OPTS} placeholder="Pick one…" />));
    expect(container.querySelector('.rx-select__value').textContent).toContain('Pick one…');
    act(() => container.querySelector('.rx-select__trigger').click());
    expect(container.querySelectorAll('.rx-select__opt').length).toBe(3);
  });

  it('filters options by the search query', () => {
    act(() => root.render(<Select value="" onChange={() => {}} options={OPTS} />));
    act(() => container.querySelector('.rx-select__trigger').click());
    const input = container.querySelector('.rx-select__search input');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'bob');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const opts = [...container.querySelectorAll('.rx-select__opt')];
    expect(opts.length).toBe(1);
    expect(opts[0].textContent).toContain('Bob Smith');
  });

  it('calls onChange with the chosen value', () => {
    const onChange = vi.fn();
    act(() => root.render(<Select value="" onChange={onChange} options={OPTS} />));
    act(() => container.querySelector('.rx-select__trigger').click());
    act(() => container.querySelectorAll('.rx-select__opt')[2].click());
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('renders the selected option label', () => {
    act(() => root.render(<Select value="a" onChange={() => {}} options={OPTS} />));
    expect(container.querySelector('.rx-select__value').textContent).toContain('Alice Johnson');
  });
});

describe('DataTable', () => {
  const columns = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'status', header: 'Status' },
  ];
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `Row ${i}`, status: 'ACTIVE' }));

  it('renders the first page of rows and paginates', () => {
    act(() => root.render(<DataTable columns={columns} rows={rows} pageSize={10} />));
    expect(container.querySelectorAll('.rx-table tbody tr').length).toBe(10);
    expect(container.querySelector('.rx-pager__info').textContent).toContain('Page 1 of 2');
    act(() => [...container.querySelectorAll('.rx-pager .rx-btn')].find((b) => b.textContent === 'Next').click());
    expect(container.querySelectorAll('.rx-table tbody tr').length).toBe(2);
  });

  it('shows the empty state when there are no rows', () => {
    act(() => root.render(<DataTable columns={columns} rows={[]} empty={<div className="mt-empty">Nothing</div>} />));
    expect(container.querySelector('.mt-empty')).toBeTruthy();
  });
});
