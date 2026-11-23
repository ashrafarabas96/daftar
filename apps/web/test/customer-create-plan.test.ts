import { describe, expect, it } from 'vitest';
import { CUSTOMER_FIELD_BOUNDS, createSubmitGuard, mintCustomerId, planCreateCustomer, type CreateFormModel } from '@/views/customers/customer-create';

/**
 * "New customer": what the form turns into a `POST /v1/customers` body.
 *
 * The mounted schema (`CustomerWriteCreateSchema`) is the contract schema MINUS
 * `contacts` and `.strict()`, so a body may carry only `customerId`, `name`
 * and the three optional texts. The server trims and judges lengths in code
 * points, and the digest it stores binds the TRIMMED text, so the client sends
 * trimmed text too: the same figures typed with stray spaces are the same
 * command, not a `customer.idempotency_conflict`.
 */
const ID = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';
const form = (over: Partial<CreateFormModel> = {}): CreateFormModel => ({ name: 'Zaytoun Grocery', phone: '', email: '', notes: '', errors: {}, ...over });

describe('planCreateCustomer', () => {
  it('sends the id and the name alone when nothing else is stated', () => {
    const planned = planCreateCustomer(form(), ID);
    expect(planned).toEqual({ ok: true, body: { customerId: ID, name: 'Zaytoun Grocery' } });
  });

  it('never sends contacts, a status, a balance or any key the strict schema does not know', () => {
    const planned = planCreateCustomer(form({ phone: '0599', email: 'a@b.co', notes: 'n' }), ID);
    if (!planned.ok) throw new Error('expected a body');
    expect(Object.keys(planned.body).sort()).toEqual(['customerId', 'email', 'name', 'notes', 'phone']);
  });

  it('sends trimmed text, and leaves an optional field that is blank out of the body', () => {
    const planned = planCreateCustomer(form({ name: '  Zaytoun  ', phone: '   ', email: ' a@b.co ', notes: '\n' }), ID);
    expect(planned).toEqual({ ok: true, body: { customerId: ID, name: 'Zaytoun', email: 'a@b.co' } });
  });

  it('keeps Arabic text and digits exactly as typed (a phone number is text, not a number)', () => {
    const planned = planCreateCustomer(form({ name: 'بقالة الزيتون', phone: '٠٥٩٩٢٣٤٥٦٧' }), ID);
    expect(planned).toEqual({ ok: true, body: { customerId: ID, name: 'بقالة الزيتون', phone: '٠٥٩٩٢٣٤٥٦٧' } });
  });

  it('refuses a missing or blank name, and says which field', () => {
    for (const name of ['', '   ', '\t\n']) {
      expect(planCreateCustomer(form({ name }), ID)).toEqual({ ok: false, errors: { name: true } });
    }
  });

  it('judges length in code points after trimming, as the server does', () => {
    const max = CUSTOMER_FIELD_BOUNDS.name.max;
    expect(planCreateCustomer(form({ name: ` ${'ب'.repeat(max)} ` }), ID).ok).toBe(true);
    expect(planCreateCustomer(form({ name: 'ب'.repeat(max + 1) }), ID)).toEqual({ ok: false, errors: { name: true } });
    // One emoji is one code point but two UTF-16 units: counting units would refuse a valid name.
    expect(planCreateCustomer(form({ name: '😀'.repeat(max) }), ID).ok).toBe(true);
    expect(planCreateCustomer(form({ phone: '1'.repeat(41) }), ID)).toEqual({ ok: false, errors: { phone: true } });
    expect(planCreateCustomer(form({ phone: '1'.repeat(40) }), ID).ok).toBe(true);
    expect(planCreateCustomer(form({ notes: 'x'.repeat(1001) }), ID)).toEqual({ ok: false, errors: { notes: true } });
    expect(planCreateCustomer(form({ notes: 'x'.repeat(1000) }), ID).ok).toBe(true);
  });

  it('requires an address-shaped email, 3..254 long', () => {
    for (const email of ['no-at-sign', 'a b@c.d', '@x', 'x@', 'a@b@c']) {
      expect(planCreateCustomer(form({ email }), ID), email).toEqual({ ok: false, errors: { email: true } });
    }
    expect(planCreateCustomer(form({ email: 'a@b' }), ID).ok).toBe(true);
    expect(planCreateCustomer(form({ email: `${'a'.repeat(251)}@b.c` }), ID)).toEqual({ ok: false, errors: { email: true } });
  });

  it('reports every bad field at once', () => {
    expect(planCreateCustomer(form({ name: '', email: 'x', phone: '1'.repeat(41) }), ID)).toEqual({
      ok: false,
      errors: { name: true, phone: true, email: true },
    });
  });

  it('refuses an id that is not a canonical lowercase uuid, rather than send it', () => {
    for (const id of ['', 'nope', ID.toUpperCase(), ID.slice(1)]) {
      expect(() => planCreateCustomer(form(), id), id).toThrow(/customerId/);
    }
  });
});

describe('mintCustomerId', () => {
  it('mints one id per call from the minter, and reuses a restored one without minting', () => {
    let calls = 0;
    const mint = () => {
      calls += 1;
      return ID;
    };
    expect(mintCustomerId(mint)).toBe(ID);
    expect(calls).toBe(1);
    const restored = '11111111-1111-4111-8111-111111111111';
    expect(mintCustomerId(mint, restored)).toBe(restored);
    expect(calls).toBe(1);
  });

  it('the default minter yields a canonical lowercase uuid', () => {
    expect(mintCustomerId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('createSubmitGuard', () => {
  it('runs one send at a time, and frees itself afterwards, success or failure', async () => {
    const guard = createSubmitGuard();
    let release: () => void = () => undefined;
    const first = guard.run(() => new Promise<string>((resolve) => (release = () => resolve('a'))));
    expect(guard.busy).toBe(true);
    expect(guard.run(async () => 'b')).toBeNull();
    release();
    await first;
    expect(guard.busy).toBe(false);
    await expect(guard.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(guard.busy).toBe(false);
    expect(await guard.run(async () => 'c')).toBe('c');
  });
});
