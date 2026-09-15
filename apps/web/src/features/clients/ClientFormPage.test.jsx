import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * REGRESSION — ClientFormPage create path reported the WRONG reason on 409.
 *
 * Root cause (not a symptom): the catch block mapped EVERY 409 to the
 * version-conflict text "This client changed since you loaded it. Reload and
 * try again." A create sends no If-Match version, so its only realistic 409 is
 * a business condition such as ORG_NOT_ACTIVE. Showing the version-conflict
 * message hid that real cause and made a fresh, valid client look un-savable —
 * matching the "valid NEW client → 409 → confusing" report.
 *
 * The fix surfaces the server's actual { error: { code, message } } and keeps
 * the reload text ONLY for a genuine edit version conflict. These tests pin
 * that contract. They also render and submit the real component with awaited
 * act(), so a state-update-after-await would raise an act() warning here.
 */

const createClient = vi.fn();
const updateClient = vi.fn();
const getClient = vi.fn();
const addGuardian = vi.fn();
const updateGuardian = vi.fn();
const navigate = vi.fn();

vi.mock('@/api/client', () => ({
  createClient: (...args) => createClient(...args),
  updateClient: (...args) => updateClient(...args),
  getClient: (...args) => getClient(...args),
  addGuardian: (...args) => addGuardian(...args),
  updateGuardian: (...args) => updateGuardian(...args),
}));

let currentPath = '/clients/new';
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => (currentPath.includes('/edit') ? { clientId: 'c-1' } : {}),
  };
});

let ClientFormPage;
beforeEach(async () => {
  ({ ClientFormPage } = await import('./ClientFormPage.jsx'));
  createClient.mockReset();
  updateClient.mockReset();
  getClient.mockReset();
  addGuardian.mockReset();
  updateGuardian.mockReset();
  navigate.mockReset();
});

let host;
let root;

const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[currentPath]}>
          <ClientFormPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
};

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined;
  host = undefined;
});

const waitForForm = async () => {
  // React Query commits the edit-load result on a macrotask tick, so a
  // microtask-only flush (Promise.resolve) is racy under load and can leave the
  // <form> unrendered. Poll on real macrotasks and fail loudly if it never
  // renders rather than dispatching on a null element.
  for (let i = 0; i < 100; i += 1) {
    if (host.querySelector('form')) return;
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); }); // eslint-disable-line no-await-in-loop
  }
  throw new Error('form never rendered');
};

const setInput = (label, value) => {
  const span = [...host.querySelectorAll('label span')].find((s) => s.textContent === label);
  const input = span.parentElement.querySelector('input, select');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};

const submit = async () => {
  const form = host.querySelector('form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // let the awaited mutation settle inside act()
    await Promise.resolve();
    await Promise.resolve();
  });
};

const errorText = () => host.querySelector('.form-error')?.textContent ?? null;

// Add Client (create) errors are covered by client-intake-wizard.test.jsx.

describe('ClientFormPage — edit still shows version-conflict correctly', () => {
  it('keeps the reload text for a genuine edit VERSION_CONFLICT', async () => {
    currentPath = '/clients/c-1/edit';
    getClient.mockResolvedValue({
      client: { id: 'c-1', firstName: 'Aman', lastName: 'Khan', version: 3 },
    });
    updateClient.mockRejectedValue({
      response: { status: 409, data: { error: { code: 'VERSION_CONFLICT', message: 'stale' } } },
    });
    mount();
    // wait for the detail query to resolve and the form to render
    await waitForForm();
    await submit();

    expect(updateClient).toHaveBeenCalledTimes(1);
    expect(errorText()).toBe('This client changed since you loaded it. Reload and try again.');
  });
});

describe('ClientFormPage — edit also edits the parent (spec Change 3)', () => {
  it('loads the existing parent and UPDATES it in place (no duplicate) on save', async () => {
    currentPath = '/clients/c-1/edit';
    getClient.mockResolvedValue({
      client: { id: 'c-1', firstName: 'Aman', lastName: 'Khan', version: 4, address: {} },
      guardians: [
        { id: 'g-1', firstName: 'Jane', lastName: 'Khan', relationship: 'PARENT', isPrimary: true, phone: '5551234567', email: 'jane@example.com' },
      ],
    });
    updateClient.mockResolvedValue({ id: 'c-1', version: 5 });
    updateGuardian.mockResolvedValue({ id: 'g-1' });
    mount();
    await waitForForm();
    // The existing parent is loaded into the form.
    const emailSpan = [...host.querySelectorAll('label span')].find((s) => s.textContent === 'Parent email');
    expect(emailSpan.parentElement.querySelector('input').value).toBe('jane@example.com');
    // Change the parent's mobile and save.
    setInput('Parent mobile number', '5559998888');
    await submit();
    // Existing parent is PATCHed in place — never a second addGuardian.
    expect(updateGuardian).toHaveBeenCalledTimes(1);
    const [cid, gid, body] = updateGuardian.mock.calls[0];
    expect(cid).toBe('c-1');
    expect(gid).toBe('g-1');
    expect(body.phone).toBe('5559998888');
    expect(addGuardian).not.toHaveBeenCalled();
  });

  it('adds a parent during edit when the client has none yet', async () => {
    currentPath = '/clients/c-1/edit';
    getClient.mockResolvedValue({
      client: { id: 'c-1', firstName: 'Aman', lastName: 'Khan', version: 2, address: {} },
      guardians: [],
    });
    updateClient.mockResolvedValue({ id: 'c-1', version: 3 });
    addGuardian.mockResolvedValue({ id: 'g-new' });
    mount();
    await waitForForm();
    setInput('Parent first name', 'Jane');
    setInput('Parent last name', 'Khan');
    setInput('Parent mobile number', '5551112222');
    setInput('Parent email', 'jane@new.com');
    await submit();
    expect(addGuardian).toHaveBeenCalledTimes(1);
    const [cid, body] = addGuardian.mock.calls[0];
    expect(cid).toBe('c-1');
    expect(body.email).toBe('jane@new.com');
    expect(body.isPrimary).toBe(true);
    expect(updateGuardian).not.toHaveBeenCalled();
  });

  it('a half-entered parent on edit is a validation error (no duplicate, no silent drop)', async () => {
    currentPath = '/clients/c-1/edit';
    getClient.mockResolvedValue({
      client: { id: 'c-1', firstName: 'Aman', lastName: 'Khan', version: 2, address: {} },
      guardians: [],
    });
    updateClient.mockResolvedValue({ id: 'c-1', version: 3 });
    mount();
    await waitForForm();
    setInput('Parent first name', 'Jane'); // name only, no mobile/email
    await submit();
    expect(errorText()).toMatch(/name, mobile number and email/i);
    expect(addGuardian).not.toHaveBeenCalled();
    expect(updateGuardian).not.toHaveBeenCalled();
    expect(updateClient).not.toHaveBeenCalled();
  });
});
