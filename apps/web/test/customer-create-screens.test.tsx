import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import tr from '@/messages/tr.json';
import { translate, type Locale } from '@/lib/i18n';
import { ApiError } from '@/lib/client';
import type { ViewFixture } from '@/lib/phase3-format';
import { refusalKey } from '@/lib/phase3-errors';
import { VIEW_REGISTRY } from '@/views/customers/registry';
import type { CustomerCreateViewProps } from '@/views/customers/CustomerCreateView';
import { PENDING_NOT_FOUND_KEY, STORED_UNREADABLE_KEY, UNCONFIRMED_KEY } from '@/views/customers/customer-create-flow';
import { stripTsComments } from '../../../scripts/guards/merchant-jargon';
import { LOCALES, elements, renderFixture, textOf, type ElementNode, type Rendered } from './helpers/render';

/**
 * "New customer", rendered through its registry fixtures in ar, en and tr:
 * the form keeps what the merchant typed when the server refuses, the button
 * is disabled while a send is in flight, a replay is a success, every value on
 * the success screen is the server's, no fixture shows a refusal the page
 * could not produce, and nothing is kept in browser storage.
 */
const WEB = join(__dirname, '..');
const NAME = 'CustomerCreateView';

function fixture(name: string): ViewFixture {
  const found = VIEW_REGISTRY.find((e) => e.name === NAME)?.fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${NAME} / ${name}`);
  return found;
}
const propsOf = (name: string): CustomerCreateViewProps => fixture(name).props as CustomerCreateViewProps;
const render = (name: string, locale: Locale = 'en'): Rendered => renderFixture(fixture(name), locale);
const all = (r: Rendered, tag: string): ElementNode[] => [...elements(r.frame)].filter((e) => e.tag === tag);
const text = (r: Rendered): string => textOf(r.frame);
const tr_ = (locale: Locale, key: string, vars?: Record<string, string>) => translate(locale, key, vars);
const buttonByLabel = (r: Rendered, label: string): ElementNode | undefined => all(r, 'button').find((b) => textOf(b) === label);
const isDisabled = (b: ElementNode): boolean => 'disabled' in b.attrs;
const inputValues = (r: Rendered): string[] => all(r, 'input').map((i) => i.attrs.value ?? '');

describe('the registry holds only states the page can reach', () => {
  const reachable = new Set<string>([
    // The mounted schema's own refusals (a domain refusal carries `details.sellingCode`).
    refusalKey(new ApiError(400, 'VALIDATION_FAILED', { sellingCode: 'customer.name_invalid' })),
    refusalKey(new ApiError(400, 'VALIDATION_FAILED', { sellingCode: 'customer.phone_invalid' })),
    refusalKey(new ApiError(400, 'VALIDATION_FAILED', { sellingCode: 'customer.email_invalid' })),
    refusalKey(new ApiError(400, 'VALIDATION_FAILED', { sellingCode: 'customer.notes_invalid' })),
    refusalKey(new ApiError(400, 'VALIDATION_FAILED')),
    refusalKey(new ApiError(403, 'FORBIDDEN')),
    // An idempotency conflict is read back, never shown; its read failing has the flow's own key.
    STORED_UNREADABLE_KEY,
    UNCONFIRMED_KEY,
    PENDING_NOT_FOUND_KEY,
  ]);

  it('the reachable set is real keys, and holds no "nothing was saved" text for an unknown outcome', () => {
    expect(reachable).toContain('error.customer.name_invalid');
    expect(reachable).toContain('error.FORBIDDEN');
    expect(reachable).not.toContain('error.fallback');
    expect(reachable).not.toContain('error.INTERNAL_ERROR');
    expect(reachable).not.toContain('error.customer.idempotency_conflict');
  });

  it('every fixture error key is reachable', () => {
    const entry = VIEW_REGISTRY.find((e) => e.name === NAME);
    expect(entry?.fixtures.length).toBeGreaterThan(8);
    const keys = (entry?.fixtures ?? []).map((f) => (f.props as CustomerCreateViewProps).errorKey).filter((k): k is string => k !== null);
    expect(keys.length).toBeGreaterThan(3);
    for (const key of keys) expect(reachable, key).toContain(key);
  });
});

describe('New customer: the form', () => {
  it('offers the name, phone, email and notes, and a save button, in every language', () => {
    for (const locale of LOCALES) {
      const r = render('empty form', locale);
      const labels = all(r, 'label').map(textOf).join(' | ');
      for (const key of ['name', 'phone', 'email', 'notes']) expect(labels).toContain(tr_(locale, `customers.create.${key}`));
      const save = buttonByLabel(r, tr_(locale, 'customers.create.submit'));
      expect(save).toBeDefined();
      expect(isDisabled(save as ElementNode)).toBe(false);
    }
  });

  it('is disabled while the send is in flight', () => {
    const r = render('sending');
    expect(buttonByLabel(r, tr_('en', 'customers.create.submit'))).toBeUndefined();
    const busy = all(r, 'button').filter((b) => b.attrs['aria-busy'] === 'true');
    expect(busy.length).toBe(1);
    expect(busy.every(isDisabled)).toBe(true);
  });

  it('a refused send keeps every value typed and shows the refusal in merchant words', () => {
    const props = propsOf('refused: the name is not valid, values kept');
    for (const locale of LOCALES) {
      const r = render('refused: the name is not valid, values kept', locale);
      expect(text(r)).toContain(tr_(locale, 'error.customer.name_invalid'));
      const values = inputValues(r);
      expect(values).toContain(props.form.name);
      expect(values).toContain(props.form.phone);
    }
  });

  it('a field the plan refused is marked, in words, beside that field', () => {
    for (const locale of LOCALES) {
      const r = render('a field is not valid', locale);
      expect(text(r)).toContain(tr_(locale, 'customers.create.emailInvalid'));
    }
  });

  it('a 403 on send is a refusal message beside the kept form', () => {
    const r = render('refused: no permission to add customers');
    expect(text(r)).toContain(tr_('en', 'error.FORBIDDEN'));
    expect(inputValues(r)).toContain(propsOf('refused: no permission to add customers').form.name);
  });

  it('no answer, not found when read back: "not confirmed", never "nothing was saved", and the form is kept', () => {
    for (const locale of LOCALES) {
      const r = render('no answer, not found when read back: not confirmed, values kept', locale);
      expect(text(r)).toContain(tr_(locale, UNCONFIRMED_KEY));
      expect(inputValues(r)).toContain(propsOf('no answer, not found when read back: not confirmed, values kept').form.name);
      expect(isDisabled(buttonByLabel(r, tr_(locale, 'customers.create.submit')) as ElementNode)).toBe(false);
    }
  });

  it('a customer that may be saved but could not be read offers "read again" and NO form', () => {
    for (const locale of LOCALES) {
      const r = render('already recorded, but it could not be read', locale);
      expect(buttonByLabel(r, tr_(locale, 'customers.create.readAgain'))).toBeDefined();
      expect(buttonByLabel(r, tr_(locale, 'customers.create.submit'))).toBeUndefined();
      expect(all(r, 'input').length).toBe(0);
      expect(text(r)).toContain(tr_(locale, STORED_UNREADABLE_KEY));
    }
  });
});

describe('New customer: a saved customer', () => {
  it('shows the server values verbatim, never the typed ones', () => {
    for (const locale of LOCALES) {
      const r = render('saved', locale);
      const props = propsOf('saved');
      const t = text(r);
      expect(t).toContain(props.result?.name ?? 'MISSING');
      expect(t).toContain(props.result?.phone ?? 'MISSING');
      expect(t).toContain(props.result?.email ?? 'MISSING');
      expect(t).toContain(tr_(locale, 'customers.create.done'));
      expect(all(r, 'input').length).toBe(0);
      expect(buttonByLabel(r, tr_(locale, 'customers.create.another'))).toBeDefined();
    }
  });

  it('a replay is a success that says it was already saved', () => {
    for (const locale of LOCALES) {
      const t = text(render('saved earlier: the same customer sent again', locale));
      expect(t).toContain(tr_(locale, 'customers.create.done'));
      expect(t).toContain(tr_(locale, 'customers.create.alreadySaved'));
    }
  });

  it('an already-stored customer says it was already recorded and shows the stored values', () => {
    for (const locale of LOCALES) {
      const r = render('already recorded: the stored customer is shown', locale);
      const props = propsOf('already recorded: the stored customer is shown');
      expect(text(r)).toContain(tr_(locale, 'customers.create.alreadyRecorded'));
      expect(text(r)).toContain(props.stored?.name ?? 'MISSING');
      expect(buttonByLabel(r, tr_(locale, 'customers.create.another'))).toBeDefined();
    }
  });

  it('an absent phone, email or notes is not rendered as a blank value or the word "null"', () => {
    const r = render('saved, with only a name');
    expect(text(r)).not.toMatch(/null|undefined/);
  });
});

describe('the catalogs', () => {
  const create = (c: Record<string, string>) => Object.keys(c).filter((k) => k.startsWith('customers.create.'));
  const used = (() => {
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/customer-create|CustomerCreate|customers[\\/]new/.test(full) && /\.tsx?$/.test(e.name)) {
          for (const m of stripTsComments(readFileSync(full, 'utf8')).matchAll(/'(customers\.create\.[A-Za-z]+)'/g)) found.add(m[1] ?? '');
        }
      }
    };
    walk(join(WEB, 'src'));
    return found;
  })();

  it('every customers.create key the screen names exists in ar, en and tr, with text', () => {
    expect(used.size).toBeGreaterThan(10);
    for (const key of used) {
      for (const [locale, catalog] of [
        ['ar', ar],
        ['en', en],
        ['tr', tr],
      ] as const) {
        const value = (catalog as Record<string, string>)[key];
        expect(typeof value === 'string' && value.length > 0, `${locale}:${key}`).toBe(true);
      }
    }
  });

  it('the three catalogs hold the same customers.create and customer error keys', () => {
    const keys = (c: Record<string, string>) =>
      Object.keys(c)
        .filter((k) => k.startsWith('customers.create.') || k.startsWith('error.customer.'))
        .filter((k) => !k.startsWith('error.customer_'))
        .sort();
    expect(keys(ar)).toEqual(keys(en));
    expect(keys(tr)).toEqual(keys(en));
    expect(create(en).length).toBeGreaterThan(10);
  });

  it('every customer refusal the create can meet has text in every language, in words and not as a code', () => {
    for (const code of ['name_invalid', 'phone_invalid', 'email_invalid', 'notes_invalid', 'idempotency_conflict']) {
      for (const [locale, catalog] of [
        ['ar', ar],
        ['en', en],
        ['tr', tr],
      ] as const) {
        const value = (catalog as Record<string, string>)[`error.customer.${code}`];
        expect(value, `${locale}:${code}`).toBeTruthy();
        expect(value).not.toMatch(/customer\.|_invalid/);
      }
    }
  });
});

describe('the customer create client', () => {
  it('POSTs to /customers with the body as given, no store, and reads back with GET /customers/:id', async () => {
    const apiFetch = vi.fn().mockResolvedValue({});
    vi.resetModules();
    vi.doMock('@/lib/client', () => ({ apiFetch }));
    const api = await import('@/lib/phase4-customers-api');
    const id = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';
    await api.createCustomer({ customerId: id, name: 'Zaytoun' });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/proxy/customers',
      expect.objectContaining({ method: 'POST', cache: 'no-store', body: JSON.stringify({ customerId: id, name: 'Zaytoun' }) }),
    );
    await api.getCustomer(id);
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/proxy/customers/${id}`, { cache: 'no-store' });
    vi.doUnmock('@/lib/client');
  });
});

describe('no browser storage (T-02 / ADR-001)', () => {
  it('no source of this screen touches localStorage, sessionStorage, IndexedDB, caches or cookies', () => {
    const files = [
      'src/views/customers/customer-create.ts',
      'src/views/customers/customer-create-flow.ts',
      'src/views/customers/CustomerCreateView.tsx',
      'src/views/customers/registry.ts',
      'src/lib/phase4-customers-api.ts',
      'src/app/[locale]/customers/new/page.tsx',
      'src/app/[locale]/customers/new/customer-create-page-kit.ts',
    ];
    for (const file of files) {
      const code = stripTsComments(readFileSync(join(WEB, file), 'utf8'));
      expect(code, file).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB|caches|document\.cookie)\b/);
    }
  });
});
