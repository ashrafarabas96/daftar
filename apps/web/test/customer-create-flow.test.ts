import { describe, expect, it } from 'vitest';
import type { CustomerCommandResultDto, CustomerDto } from '@daftar/shared-contracts';
import { ApiError } from '@/lib/client';
import type { CreateCustomerRequestDto } from '@/lib/phase4-customers-api';
import { planCreateCustomer, type CreateFormModel } from '@/views/customers/customer-create';
import {
  PENDING_CUSTOMER_PARAM,
  PENDING_NOT_FOUND_KEY,
  STORED_UNREADABLE_KEY,
  UNCONFIRMED_KEY,
  afterOutcome,
  beforeSend,
  createCustomerFlow,
  urlPendingMarker,
  type CreateScreenState,
  type PendingMarker,
} from '@/views/customers/customer-create-flow';

/**
 * The send logic of "New customer", outside React. What it must guarantee:
 *
 * - the customer id is minted ONCE per flow and every send carries it: the id
 *   IS the server's idempotency key (P4-AL-30), so a second id is a second
 *   customer;
 * - a double click sends once;
 * - `customer.idempotency_conflict` means a customer with this id is ALREADY
 *   STORED under a different statement, so the stored customer is read and
 *   shown, never "start over";
 * - no answer, or a 5xx, says nothing about whether it was saved: the customer
 *   is READ BACK by its id, never blindly created again, and never shown as
 *   "nothing was saved";
 * - a refusal leaves the typed form as it was.
 */
const ID_1 = '00000000-0000-4000-8000-000000000001';

const form = (over: Partial<CreateFormModel> = {}): CreateFormModel => ({ name: 'Zaytoun Grocery', phone: '0599', email: '', notes: '', errors: {}, ...over });
const plan = (f: CreateFormModel) => (id: string) => planCreateCustomer(f, id);

function minter() {
  let n = 0;
  return {
    mint: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    },
    count: () => n,
  };
}

const stored = (id: string, over: Partial<CustomerDto> = {}): CustomerDto => ({
  id,
  name: 'Zaytoun Grocery',
  phone: '0599',
  email: null,
  notes: null,
  status: 'active',
  revision: 1,
  createdAt: '2026-11-13T08:00:00Z',
  updatedAt: '2026-11-13T08:00:00Z',
  contacts: [],
  ...over,
});
const answer = (body: CreateCustomerRequestDto, replayed: boolean): CustomerCommandResultDto => ({
  ...stored(body.customerId, { name: body.name, phone: body.phone ?? null }),
  replayed,
  businessTransactionId: '22222222-2222-4222-8222-222222222222',
});

const refusal = (status: number, sellingCode: string) =>
  new ApiError(status, status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED', { sellingCode });
const never = () => Promise.reject(new Error('unexpected call'));

function fakeMarker(initial: string | null = null): PendingMarker & { value: string | null; log: string[] } {
  const m = {
    value: initial,
    log: [] as string[],
    read: () => m.value,
    write: (id: string) => {
      m.value = id;
      m.log.push(`write:${id}`);
    },
    clear: () => {
      m.value = null;
      m.log.push('clear');
    },
  };
  return m;
}

describe('the id', () => {
  it('is minted once, and every send of the flow carries it: after a refusal, after an edit', async () => {
    const m = minter();
    const bodies: CreateCustomerRequestDto[] = [];
    const flow = createCustomerFlow({
      mint: m.mint,
      readStored: never,
      send: (b) => {
        bodies.push(b);
        return bodies.length < 3 ? Promise.reject(refusal(400, 'customer.name_invalid')) : Promise.resolve(answer(b, false));
      },
    });
    await flow.submit(plan(form()));
    await flow.submit(plan(form({ name: 'Zaytoun' })));
    await flow.submit(plan(form({ name: 'Zaytoun Grocery 2' })));
    expect(m.count()).toBe(1);
    expect(bodies.map((b) => b.customerId)).toEqual([flow.customerId, flow.customerId, flow.customerId]);
    expect(flow.customerId).toBe(ID_1);
  });

  it('a new flow is a new id', () => {
    const m = minter();
    const a = createCustomerFlow({ mint: m.mint, send: never, readStored: never });
    const b = createCustomerFlow({ mint: m.mint, send: never, readStored: never });
    expect(a.customerId).not.toBe(b.customerId);
  });
});

describe('a send', () => {
  it('an invalid form sends nothing and names the fields', async () => {
    const flow = createCustomerFlow({ mint: minter().mint, send: never, readStored: never });
    expect(await flow.submit(plan(form({ name: '' })))).toEqual({ kind: 'invalid', errors: { name: true } });
  });

  it('a double click sends once: the second submit while one is in flight returns null', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const flow = createCustomerFlow({
      mint: minter().mint,
      readStored: never,
      send: (b) => {
        calls += 1;
        return new Promise((resolve) => (release = () => resolve(answer(b, false))));
      },
    });
    const first = flow.submit(plan(form()));
    expect(flow.submit(plan(form()))).toBeNull();
    release();
    expect(await first).toMatchObject({ kind: 'saved' });
    expect(calls).toBe(1);
  });

  it('saved: the server answer is the outcome, a replay included', async () => {
    const flow = createCustomerFlow({ mint: minter().mint, readStored: never, send: (b) => Promise.resolve(answer(b, true)) });
    const outcome = await flow.submit(plan(form()));
    expect(outcome).toMatchObject({ kind: 'saved', customer: { id: ID_1, replayed: true } });
  });

  it('an explicit refusal is shown as that refusal, keyed from its own code, and reads nothing back', async () => {
    const flow = createCustomerFlow({ mint: minter().mint, readStored: never, send: () => Promise.reject(refusal(400, 'customer.email_invalid')) });
    expect(await flow.submit(plan(form()))).toEqual({ kind: 'refused', errorKey: 'error.customer.email_invalid' });
  });

  it('a 403 is a refusal, not an unknown outcome', async () => {
    const flow = createCustomerFlow({ mint: minter().mint, readStored: never, send: () => Promise.reject(new ApiError(403, 'FORBIDDEN')) });
    expect(await flow.submit(plan(form()))).toEqual({ kind: 'refused', errorKey: 'error.FORBIDDEN' });
  });
});

describe('customer.idempotency_conflict: the customer is already stored', () => {
  it('reads the stored customer by the SAME id and shows it, sending nothing again', async () => {
    const reads: string[] = [];
    let sends = 0;
    const flow = createCustomerFlow({
      mint: minter().mint,
      send: () => {
        sends += 1;
        return Promise.reject(refusal(409, 'customer.idempotency_conflict'));
      },
      readStored: (id) => {
        reads.push(id);
        return Promise.resolve(stored(id, { name: 'Zaytoun Grocery (as first saved)' }));
      },
    });
    const outcome = await flow.submit(plan(form({ name: 'Zaytoun Grocery edited' })));
    expect(outcome).toMatchObject({ kind: 'alreadySaved', customer: { id: ID_1, name: 'Zaytoun Grocery (as first saved)' } });
    expect(reads).toEqual([ID_1]);
    expect(sends).toBe(1);
  });

  it('when the stored customer cannot be read, it says it may be saved and offers to read again, never a new form', async () => {
    let reads = 0;
    const flow = createCustomerFlow({
      mint: minter().mint,
      send: () => Promise.reject(refusal(409, 'customer.idempotency_conflict')),
      readStored: (id) => {
        reads += 1;
        return reads === 1 ? Promise.reject(new ApiError(403, 'FORBIDDEN')) : Promise.resolve(stored(id));
      },
    });
    expect(await flow.submit(plan(form()))).toEqual({ kind: 'storedUnread' });
    expect(await flow.rereadStored()).toMatchObject({ kind: 'alreadySaved' });
  });

  it('a not-found read after an idempotency conflict is still "unread": a conflict proves it is stored', async () => {
    const flow = createCustomerFlow({
      mint: minter().mint,
      send: () => Promise.reject(refusal(409, 'customer.idempotency_conflict')),
      readStored: () => Promise.reject(refusal(404, 'customer.not_found')),
    });
    expect(await flow.submit(plan(form()))).toEqual({ kind: 'storedUnread' });
  });
});

describe('no answer, or a 5xx: the outcome is unknown', () => {
  const unknown = [
    ['no answer (a network failure)', () => new TypeError('Failed to fetch')],
    ['a 500', () => new ApiError(500, 'INTERNAL_ERROR')],
    ['a 503', () => new ApiError(503, 'UNAVAILABLE')],
  ] as const;

  for (const [label, failure] of unknown) {
    it(`${label}: the customer is read back by its id and, when found, shown as saved`, async () => {
      const reads: string[] = [];
      const flow = createCustomerFlow({
        mint: minter().mint,
        send: () => Promise.reject(failure()),
        readStored: (id) => {
          reads.push(id);
          return Promise.resolve(stored(id));
        },
      });
      expect(await flow.submit(plan(form()))).toMatchObject({ kind: 'alreadySaved', customer: { id: ID_1 } });
      expect(reads).toEqual([ID_1]);
    });

    it(`${label}: read back and NOT found says "not confirmed" (never "nothing was saved"), and Save again re-sends the SAME id`, async () => {
      const m = minter();
      const bodies: CreateCustomerRequestDto[] = [];
      const flow = createCustomerFlow({
        mint: m.mint,
        send: (b) => {
          bodies.push(b);
          return bodies.length === 1 ? Promise.reject(failure()) : Promise.resolve(answer(b, false));
        },
        readStored: () => Promise.reject(refusal(404, 'customer.not_found')),
      });
      expect(await flow.submit(plan(form()))).toEqual({ kind: 'unconfirmed', errorKey: UNCONFIRMED_KEY });
      expect(await flow.submit(plan(form()))).toMatchObject({ kind: 'saved' });
      expect(m.count()).toBe(1);
      expect(bodies.map((b) => b.customerId)).toEqual([ID_1, ID_1]);
    });

    it(`${label}: read back and the read fails otherwise, it may be saved: read again, no new form`, async () => {
      const flow = createCustomerFlow({
        mint: minter().mint,
        send: () => Promise.reject(failure()),
        readStored: () => Promise.reject(new TypeError('Failed to fetch')),
      });
      expect(await flow.submit(plan(form()))).toEqual({ kind: 'storedUnread' });
    });
  }

  it('a refusal AFTER an unknown send keeps the pending marker: the earlier send may still be stored', async () => {
    const marker = fakeMarker();
    let sends = 0;
    const flow = createCustomerFlow({
      mint: minter().mint,
      pending: marker,
      send: () => {
        sends += 1;
        return sends === 1 ? Promise.reject(new TypeError('offline')) : Promise.reject(refusal(400, 'customer.name_invalid'));
      },
      readStored: () => Promise.reject(refusal(404, 'customer.not_found')),
    });
    await flow.submit(plan(form()));
    expect(await flow.submit(plan(form()))).toMatchObject({ kind: 'refused' });
    expect(marker.value).toBe(ID_1);
  });
});

describe('the pending marker (the page address, never browser storage)', () => {
  it('is written BEFORE the send leaves, and cleared once the customer is saved', async () => {
    const marker = fakeMarker();
    let valueDuringSend: string | null = 'unset';
    const flow = createCustomerFlow({
      mint: minter().mint,
      pending: marker,
      readStored: never,
      send: (b) => {
        valueDuringSend = marker.value;
        return Promise.resolve(answer(b, false));
      },
    });
    await flow.submit(plan(form()));
    expect(valueDuringSend).toBe(ID_1);
    expect(marker.value).toBeNull();
  });

  it('is cleared after an explicit refusal when no earlier send is uncertain', async () => {
    const marker = fakeMarker();
    const flow = createCustomerFlow({
      mint: minter().mint,
      pending: marker,
      readStored: never,
      send: () => Promise.reject(refusal(400, 'customer.name_invalid')),
    });
    await flow.submit(plan(form()));
    expect(marker.value).toBeNull();
  });

  it('stays after an unconfirmed send, so a reload re-opens the same id', async () => {
    const marker = fakeMarker();
    const flow = createCustomerFlow({
      mint: minter().mint,
      pending: marker,
      send: () => Promise.reject(new TypeError('offline')),
      readStored: () => Promise.reject(refusal(404, 'customer.not_found')),
    });
    await flow.submit(plan(form()));
    expect(marker.value).toBe(ID_1);
  });

  it('a reload with a marker re-uses its id, mints nothing, and reads the earlier send back first', async () => {
    const RESTORED = '99999999-9999-4999-8999-999999999999';
    const m = minter();
    const marker = fakeMarker(RESTORED);
    const reads: string[] = [];
    const flow = createCustomerFlow({
      mint: m.mint,
      pending: marker,
      send: never,
      readStored: (id) => {
        reads.push(id);
        return Promise.resolve(stored(id));
      },
    });
    expect(flow.resumed).toBe(true);
    expect(flow.customerId).toBe(RESTORED);
    expect(m.count()).toBe(0);
    expect(await flow.resume()).toMatchObject({ kind: 'alreadySaved', customer: { id: RESTORED } });
    expect(reads).toEqual([RESTORED]);
    expect(marker.value).toBeNull();
  });

  it('a resumed send that is not found gives the form back under the SAME id, with its own text', async () => {
    const RESTORED = '99999999-9999-4999-8999-999999999999';
    const bodies: CreateCustomerRequestDto[] = [];
    const flow = createCustomerFlow({
      mint: minter().mint,
      pending: fakeMarker(RESTORED),
      send: (b) => {
        bodies.push(b);
        return Promise.resolve(answer(b, false));
      },
      readStored: () => Promise.reject(refusal(404, 'customer.not_found')),
    });
    expect(await flow.resume()).toEqual({ kind: 'unconfirmed', errorKey: PENDING_NOT_FOUND_KEY });
    await flow.submit(plan(form()));
    expect(bodies.map((b) => b.customerId)).toEqual([RESTORED]);
  });

  it('a flow with no marker is not resumed, and resume() does nothing', () => {
    const flow = createCustomerFlow({ mint: minter().mint, send: never, readStored: never });
    expect(flow.resumed).toBe(false);
    expect(flow.resume()).toBeNull();
  });
});

describe('urlPendingMarker', () => {
  const windowAt = (href: string) => {
    const calls: string[] = [];
    const win = {
      location: { href },
      history: {
        state: { router: 1 },
        replaceState(state: unknown, _unused: string, url?: string | URL | null) {
          calls.push(String(url));
          win.location.href = String(url);
          expect(state).toEqual({ router: 1 });
        },
      },
    };
    return { win, calls };
  };
  const UUID = 'a9999999-9999-4999-8999-99999999999b';

  it('reads only one UUID from ?customer=, and ignores anything else', () => {
    expect(PENDING_CUSTOMER_PARAM).toBe('customer');
    expect(urlPendingMarker(windowAt(`http://x.test/ar/customers/new?customer=${UUID}`).win).read()).toBe(UUID);
    for (const bad of ['', 'nope', `${UUID}x`, UUID.toUpperCase()]) {
      expect(urlPendingMarker(windowAt(`http://x.test/ar/customers/new?customer=${bad}`).win).read(), bad).toBeNull();
    }
    expect(urlPendingMarker(windowAt('http://x.test/ar/customers/new').win).read()).toBeNull();
  });

  it('writes and clears the parameter in place, keeping the rest of the address and the router state', () => {
    const { win, calls } = windowAt('http://x.test/ar/customers/new?a=1#top');
    const marker = urlPendingMarker(win);
    marker.write(UUID);
    expect(calls[0]).toBe(`http://x.test/ar/customers/new?a=1&customer=${UUID}#top`);
    expect(marker.read()).toBe(UUID);
    marker.clear();
    expect(calls[1]).toBe('http://x.test/ar/customers/new?a=1#top');
  });

  it('never throws when the address cannot be written', () => {
    const win = {
      location: { href: 'http://x.test/p' },
      history: {
        state: null,
        replaceState() {
          throw new Error('SecurityError');
        },
      },
    };
    const marker = urlPendingMarker(win);
    expect(() => marker.write(UUID)).not.toThrow();
    expect(() => marker.clear()).not.toThrow();
  });
});

describe('the screen state', () => {
  const state = (over: Partial<CreateScreenState> = {}): CreateScreenState => ({
    form: form({ name: 'Typed' }),
    busy: true,
    errorKey: null,
    result: null,
    stored: null,
    storedUnread: false,
    ...over,
  });
  const saved = answer({ customerId: ID_1, name: 'Typed' }, false);

  it('beforeSend: busy, the last refusal and field errors cleared, every figure kept', () => {
    const s = beforeSend(state({ busy: false, errorKey: 'error.FORBIDDEN', form: form({ errors: { name: true } }) }));
    expect(s).toMatchObject({ busy: true, errorKey: null, form: { name: 'Zaytoun Grocery', errors: {} } });
  });

  it('invalid sets the field errors and nothing else typed', () => {
    const s = afterOutcome(state(), { kind: 'invalid', errors: { email: true } });
    expect(s).toMatchObject({ busy: false, errorKey: null, form: { name: 'Typed', phone: '0599', errors: { email: true } } });
  });

  it('saved holds the server answer; alreadySaved holds the stored customer; storedUnread has its own key', () => {
    expect(afterOutcome(state(), { kind: 'saved', customer: saved })).toMatchObject({ busy: false, result: saved, stored: null });
    expect(afterOutcome(state(), { kind: 'alreadySaved', customer: stored(ID_1) })).toMatchObject({ stored: { id: ID_1 }, result: null });
    expect(afterOutcome(state(), { kind: 'storedUnread' })).toMatchObject({ errorKey: STORED_UNREADABLE_KEY, storedUnread: true });
  });

  it('a refusal and an unconfirmed send change the text and nothing typed', () => {
    expect(afterOutcome(state(), { kind: 'refused', errorKey: 'error.customer.name_invalid' })).toMatchObject({
      busy: false,
      errorKey: 'error.customer.name_invalid',
      form: { name: 'Typed' },
      result: null,
      stored: null,
    });
    expect(afterOutcome(state(), { kind: 'unconfirmed', errorKey: UNCONFIRMED_KEY })).toMatchObject({
      errorKey: UNCONFIRMED_KEY,
      form: { name: 'Typed' },
      stored: null,
    });
  });
});
