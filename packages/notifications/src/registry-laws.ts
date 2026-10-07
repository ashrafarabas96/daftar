/**
 * Registry consistency laws, executable and PARAMETERIZED.
 *
 * They take the catalog and the template set as arguments (defaulting to the
 * live ones) for one reason: a proof must be able to plant a violation in a
 * COPY and watch the named law turn red. A law that can only ever read the
 * correct live registry proves nothing — it would stay green with its subject
 * deleted. Each law is paired with a red proof in test/registry-laws.test.ts.
 */
import { catalogEntries, type CatalogEntry } from './catalog';
import { placeholdersOf, templateEntries, type TemplateEntry } from './template-registry';
import { LOCALES } from './types';

export interface LawViolation {
  readonly law: string;
  readonly subject: string;
}

export const REGISTRY_LAWS: readonly string[] = [
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

/**
 * @param catalog   the kind registry under test
 * @param templates the template set under test
 */
export function registryViolations(
  catalog: readonly CatalogEntry[] = catalogEntries(),
  templates: readonly TemplateEntry[] = templateEntries(),
): readonly LawViolation[] {
  const out: LawViolation[] = [];
  const byKind = new Map<string, CatalogEntry>(catalog.map((e) => [e.kind, e]));

  // L1 — every kind has a template in EVERY product locale.
  for (const entry of catalog) {
    for (const locale of LOCALES) {
      if (!templates.some((t) => t.kind === entry.kind && t.locale === locale)) {
        out.push({ law: 'L1_LOCALE_COVERAGE', subject: `${entry.kind}/${locale}` });
      }
    }
  }

  for (const tpl of templates) {
    const entry = byKind.get(tpl.kind);
    if (!entry) {
      out.push({ law: 'L2_UNDECLARED_PLACEHOLDER', subject: `${tpl.kind}: no catalog entry` });
      continue;
    }
    const declared = new Set(entry.variables.map((v) => v.name));
    const used = new Set([...placeholdersOf(tpl.subject), ...placeholdersOf(tpl.body)]);

    // L2 — a template uses no placeholder the catalog has not declared.
    for (const name of used) {
      if (!declared.has(name)) out.push({ law: 'L2_UNDECLARED_PLACEHOLDER', subject: `${tpl.kind}/${tpl.locale}/${name}` });
    }

    // L3 — every REQUIRED catalog variable appears in the rendered text.
    for (const v of entry.variables) {
      if (v.required && !used.has(v.name)) out.push({ law: 'L3_REQUIRED_UNUSED', subject: `${tpl.kind}/${tpl.locale}/${v.name}` });
    }

    // L4a — the WhatsApp parameter list names only placeholders the text uses.
    for (const p of tpl.whatsappParameters) {
      if (!used.has(p)) out.push({ law: 'L4_WHATSAPP_PARAM_UNUSED', subject: `${tpl.kind}/${tpl.locale}/${p}` });
    }
  }

  // L4b — one approved WhatsApp template per kind: same name, same parameter
  // order in every locale. A drift here means the Meta-approved template and
  // the code disagree, and the provider rejects the send at the customer's end.
  const signatures = new Map<string, string>();
  for (const tpl of templates) {
    const signature = `${tpl.whatsappTemplateName}(${tpl.whatsappParameters.join(',')})`;
    const seen = signatures.get(tpl.kind);
    if (seen === undefined) signatures.set(tpl.kind, signature);
    else if (seen !== signature) out.push({ law: 'L4_WHATSAPP_SIGNATURE_DRIFT', subject: `${tpl.kind}/${tpl.locale}` });
  }

  for (const entry of catalog) {
    // L5 — a kind's channel list is non-empty and duplicate-free.
    if (entry.channels.length === 0) out.push({ law: 'L5_CHANNELS_EMPTY', subject: entry.kind });
    if (new Set(entry.channels).size !== entry.channels.length) out.push({ law: 'L5_CHANNELS_DUPLICATE', subject: entry.kind });

    // L6 — a marketing kind is customer contact, never a staff report.
    if (entry.consent === 'marketing' && entry.audience === 'staff') out.push({ law: 'L6_MARKETING_AUDIENCE', subject: entry.kind });

    // L7 — an outbox-triggered kind names a versioned event type and the keys
    // it reads. `businessId` is mandatory: a notification without a business
    // cannot be tenant-scoped, and an untenanted notification is a data leak.
    if (entry.trigger.source === 'outbox') {
      if (!/^[a-z][a-z_]*\.[a-z][a-z_]*(\.v\d+)?$/.test(entry.trigger.eventType)) {
        out.push({ law: 'L7_OUTBOX_EVENT_TYPE_SHAPE', subject: `${entry.kind}/${entry.trigger.eventType}` });
      }
      if (!entry.trigger.payloadKeys.includes('businessId')) {
        out.push({ law: 'L7_OUTBOX_EVENT_TYPE_SHAPE', subject: `${entry.kind}: payloadKeys without businessId` });
      }
    }
  }

  return out;
}
