import { describe, expect, it } from 'vitest';
import { catalogEntries, type CatalogEntry } from '../src/catalog';
import { templateEntries, type TemplateEntry } from '../src/template-registry';
import { registryViolations, REGISTRY_LAWS } from '../src/registry-laws';
import { LOCALES } from '../src/types';

/** Deep-enough copies: the laws read arrays and strings, nothing else. */
const catalog = (): CatalogEntry[] => catalogEntries().map((e) => ({ ...e, variables: e.variables.map((v) => ({ ...v })), channels: [...e.channels] }));
const templates = (): TemplateEntry[] => templateEntries().map((t) => ({ ...t, whatsappParameters: [...t.whatsappParameters] }));

const laws = (violations: readonly { law: string }[]): string[] => [...new Set(violations.map((v) => v.law))].sort();

describe('the live registry', () => {
  it('satisfies every law', () => {
    expect(registryViolations()).toEqual([]);
  });

  it('covers all three product locales for every kind', () => {
    for (const entry of catalogEntries()) {
      for (const locale of LOCALES) {
        expect(
          templateEntries().some((t) => t.kind === entry.kind && t.locale === locale),
          `${entry.kind}/${locale}`,
        ).toBe(true);
      }
    }
  });

  it('is not empty — a law set over an empty registry proves nothing', () => {
    expect(catalogEntries().length).toBeGreaterThanOrEqual(8);
    expect(templateEntries().length).toBe(catalogEntries().length * LOCALES.length);
  });
});

/**
 * One planted violation per law. Each proof FIRST asserts the mutation landed
 * (the copy really differs from the live registry in the intended way) and only
 * then reads the verdict — a sed that matches nothing goes green otherwise.
 */
describe('each law turns red on its own violation', () => {
  it('L1_LOCALE_COVERAGE — a kind loses its Turkish template', () => {
    const t = templates();
    const before = t.length;
    const kept = t.filter((x) => !(x.kind === 'invoice_issued' && x.locale === 'tr'));
    expect(kept.length).toBe(before - 1); // mutation landed
    expect(laws(registryViolations(catalog(), kept))).toContain('L1_LOCALE_COVERAGE');
  });

  it('L2_UNDECLARED_PLACEHOLDER — a template invents a variable', () => {
    const t = templates();
    const target = t.find((x) => x.kind === 'invoice_issued' && x.locale === 'en');
    expect(target).toBeDefined();
    if (!target) return;
    const mutated = { ...target, body: `${target.body} {{secretDiscount}}` };
    expect(mutated.body).not.toBe(target.body); // mutation landed
    const set = t.map((x) => (x === target ? mutated : x));
    expect(laws(registryViolations(catalog(), set))).toContain('L2_UNDECLARED_PLACEHOLDER');
  });

  it('L3_REQUIRED_UNUSED — a required variable disappears from the text', () => {
    const t = templates();
    const target = t.find((x) => x.kind === 'payment_receipt' && x.locale === 'ar');
    expect(target).toBeDefined();
    if (!target) return;
    const mutated = {
      ...target,
      body: target.body.replace('{{outstandingAfter}}', ''),
      whatsappParameters: target.whatsappParameters.filter((p) => p !== 'outstandingAfter'),
    };
    expect(mutated.body).not.toContain('{{outstandingAfter}}'); // mutation landed
    expect(mutated.body).not.toBe(target.body);
    const set = t.map((x) => (x === target ? mutated : x));
    const found = registryViolations(catalog(), set);
    expect(laws(found)).toContain('L3_REQUIRED_UNUSED');
    expect(found.some((v) => v.law === 'L3_REQUIRED_UNUSED' && v.subject === 'payment_receipt/ar/outstandingAfter')).toBe(true);
  });

  it('L4_WHATSAPP_PARAM_UNUSED — the approved parameter list names a ghost', () => {
    const t = templates();
    const target = t.find((x) => x.kind === 'low_stock_alert' && x.locale === 'en');
    expect(target).toBeDefined();
    if (!target) return;
    const mutated = { ...target, whatsappParameters: [...target.whatsappParameters, 'reorderQty'] };
    expect(mutated.whatsappParameters).not.toEqual(target.whatsappParameters); // mutation landed
    const set = t.map((x) => (x === target ? mutated : x));
    expect(laws(registryViolations(catalog(), set))).toContain('L4_WHATSAPP_PARAM_UNUSED');
  });

  it('L4_WHATSAPP_SIGNATURE_DRIFT — one locale reorders the approved parameters', () => {
    const t = templates();
    const target = t.find((x) => x.kind === 'invoice_issued' && x.locale === 'tr');
    expect(target).toBeDefined();
    if (!target) return;
    const reordered = [...target.whatsappParameters].reverse();
    const mutated = { ...target, whatsappParameters: reordered };
    expect(mutated.whatsappParameters).not.toEqual(target.whatsappParameters); // mutation landed
    const set = t.map((x) => (x === target ? mutated : x));
    const found = registryViolations(catalog(), set);
    expect(laws(found)).toContain('L4_WHATSAPP_SIGNATURE_DRIFT');
    // The drift is reported against the locale that differs, not the first one.
    expect(found.some((v) => v.law === 'L4_WHATSAPP_SIGNATURE_DRIFT' && v.subject === 'invoice_issued/tr')).toBe(true);
  });

  it('L5_CHANNELS_EMPTY — a kind is left with no channel', () => {
    const c = catalog();
    const target = c.find((x) => x.kind === 'customer_statement');
    expect(target).toBeDefined();
    if (!target) return;
    expect(target.channels.length).toBeGreaterThan(0);
    const set = c.map((x) => (x === target ? { ...x, channels: [] } : x));
    expect(laws(registryViolations(set, templates()))).toContain('L5_CHANNELS_EMPTY');
  });

  it('L5_CHANNELS_DUPLICATE — a channel is listed twice', () => {
    const c = catalog();
    const target = c.find((x) => x.kind === 'customer_statement');
    expect(target).toBeDefined();
    if (!target) return;
    const mutated = { ...target, channels: [...target.channels, 'email' as const] };
    expect(mutated.channels.length).toBe(target.channels.length + 1); // mutation landed
    const set = c.map((x) => (x === target ? mutated : x));
    expect(laws(registryViolations(set, templates()))).toContain('L5_CHANNELS_DUPLICATE');
  });

  it('L6_MARKETING_AUDIENCE — a staff report is reclassified as marketing', () => {
    const c = catalog();
    const target = c.find((x) => x.kind === 'daily_sales_report');
    expect(target).toBeDefined();
    if (!target) return;
    expect(target.audience).toBe('staff');
    const set = c.map((x) => (x === target ? { ...x, consent: 'marketing' as const } : x));
    expect(laws(registryViolations(set, templates()))).toContain('L6_MARKETING_AUDIENCE');
  });

  it('L7_OUTBOX_EVENT_TYPE_SHAPE — an outbox kind stops carrying businessId', () => {
    const c = catalog();
    const target = c.find((x) => x.kind === 'invoice_issued');
    expect(target).toBeDefined();
    if (!target || target.trigger.source !== 'outbox') return;
    const mutated: CatalogEntry = { ...target, trigger: { ...target.trigger, payloadKeys: target.trigger.payloadKeys.filter((k) => k !== 'businessId') } };
    expect(target.trigger.payloadKeys).toContain('businessId'); // mutation landed
    const set = c.map((x) => (x === target ? mutated : x));
    expect(laws(registryViolations(set, templates()))).toContain('L7_OUTBOX_EVENT_TYPE_SHAPE');
  });

  it('every declared law name is reachable by one of the proofs above', () => {
    // The list and the proofs are kept honest against each other: a law added
    // to REGISTRY_LAWS without a red proof fails here by name.
    const proven = [
      'L1_LOCALE_COVERAGE',
      'L2_UNDECLARED_PLACEHOLDER',
      'L3_REQUIRED_UNUSED',
      'L4_WHATSAPP_PARAM_UNUSED',
      'L4_WHATSAPP_SIGNATURE_DRIFT',
      'L5_CHANNELS_EMPTY',
      'L5_CHANNELS_DUPLICATE',
      'L6_MARKETING_AUDIENCE',
      'L7_OUTBOX_EVENT_TYPE_SHAPE',
    ];
    expect([...REGISTRY_LAWS].sort()).toEqual([...proven].sort());
  });
});
