/**
 * P4-S1 — THE PHASE 4 RELATIONS AND ROUTINES, AS A TEST FIXTURE
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md §5, §11, §13 P4-AL-44; P4-AL-88).
 *
 * The re-expressions of the accepted Phase 3 suites (P4-AL-88) cannot be
 * proved against the real next migration, because the migration that creates
 * the first Phase 4 relations is the migration owner's and does not exist
 * yet. So the estate's own idiom is used instead: the objects are created in a
 * SCRATCH database (or inside a transaction that is always rolled back) and
 * the re-expressed assertion is then required to be GREEN with them present
 * and RED when the PHASE 3 half is genuinely wrong.
 *
 * This is a FIXTURE, not a model of the migration: it carries the five
 * relations and the four routines the next migration is specified to create,
 * in the shape the lock requires of them, and nothing else. Nothing here is
 * an allowlist and nothing here is imported by a gate: a suite that asserted
 * "these names exist and that is fine" would assert nothing (§17.3), and the
 * laws these fixtures are fed to name no Phase 4 relation at all.
 *
 * The shape, and why each part of it is here:
 *
 *   - `tax_minor` on `invoices` and `invoice_items`: `bigint`, NOT NULL, with
 *     `CHECK (tax_minor = 0)`. P4-AL-44 ships exactly that while OD-03 is
 *     open, and it is what the re-expressed OD-03 law judges.
 *   - RLS ENABLEd and FORCEd on every relation, `REVOKE ALL … FROM PUBLIC`,
 *     and no grant to any runtime principal: the T-04 laws that are NOT
 *     scoped to Phase 3 must be GREEN over these, which is the evidence that
 *     they reach Phase 4's own tables.
 *  - the four read routines SECURITY INVOKER, STABLE, `search_path` pinned to
 *     `pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC` and then
 *     EXECUTE to the principals the grant model records — the shape the first
 *     Phase 4 migration actually gave them — plus one SECURITY DEFINER
 *     trigger function owned by a NOLOGIN internal principal, which is the
 *     shape its seven guard functions have. The seven T-05 clauses must be
 *     GREEN over all of them.
 *
 * Money is `bigint` minor units throughout (lock §5).
 */

/** The relations the fixture creates, in creation order (children after parents). */
export const PROBE_RELATIONS: readonly string[] = ['customers', 'customer_contacts', 'invoice_sequences', 'invoices', 'invoice_items'];

/** The routines the fixture creates, as `oid::regprocedure` renders them without a schema. */
export const PROBE_ROUTINES: readonly string[] = [
  'customer_ar_aging(uuid,uuid,date,integer[])',
  'customer_ar_outstanding(uuid,uuid)',
  'invoice_outstanding(uuid,uuid)',
  'invoice_settlement_state(uuid,uuid)',
];

/** The principals the fixture grants SELECT to, mirroring what the migration grants. */
export const PROBE_TABLE_READERS: readonly string[] = ['daftar_app', 'daftar_inventory_internal'];

/** The principals the fixture grants EXECUTE to on the four read routines. */
export const PROBE_ROUTINE_READERS: readonly string[] = ['daftar_app', 'daftar_inventory_internal'];

/** The owner the fixture gives its one DEFINER trigger function: a NOLOGIN internal principal (T-05 clause 2). */
export const PROBE_TRIGGER_OWNER = 'daftar_inventory_internal';

/** The `search_path` T-05 clause 1 requires of a SECURITY DEFINER routine. */
const PINNED_PATH = 'pg_catalog, public, pg_temp';

const TABLE_DDL: readonly string[] = [
  `CREATE TABLE customers (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id    UUID NOT NULL,
     business_id  UUID NOT NULL,
     display_name TEXT NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE customer_contacts (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id   UUID NOT NULL,
     business_id UUID NOT NULL,
     customer_id UUID NOT NULL REFERENCES customers (id),
     channel     TEXT NOT NULL,
     value       TEXT NOT NULL
   )`,
  `CREATE TABLE invoice_sequences (
     tenant_id   UUID NOT NULL,
     business_id UUID NOT NULL,
     period      TEXT NOT NULL,
     next_number BIGINT NOT NULL DEFAULT 1,
     PRIMARY KEY (business_id, period)
   )`,
  `CREATE TABLE invoices (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id     UUID NOT NULL,
     business_id   UUID NOT NULL,
     customer_id   UUID NOT NULL REFERENCES customers (id),
     issued_on     DATE NOT NULL,
     subtotal_minor BIGINT NOT NULL,
     tax_minor     BIGINT NOT NULL DEFAULT 0,
     total_minor   BIGINT NOT NULL,
     CONSTRAINT invoices_tax_policy_absent_ck CHECK (tax_minor = 0)
   )`,
  `CREATE TABLE invoice_items (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id    UUID NOT NULL,
     business_id  UUID NOT NULL,
     invoice_id   UUID NOT NULL REFERENCES invoices (id),
     variant_id   UUID NULL,
     qty          NUMERIC(18, 4) NOT NULL,
     unit_price_minor BIGINT NOT NULL,
     tax_minor    BIGINT NOT NULL DEFAULT 0,
     CONSTRAINT invoice_items_tax_policy_absent_ck CHECK (tax_minor = 0)
   )`,
];

const ROUTINE_DDL: readonly { readonly sig: string; readonly create: string }[] = [
  {
    sig: 'invoice_outstanding(uuid,uuid)',
    create: `CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_id UUID) RETURNS BIGINT
               LANGUAGE sql STABLE SET search_path = ${PINNED_PATH}
               AS $fn$ SELECT coalesce(max(i.total_minor), 0)::BIGINT FROM public.invoices i
                        WHERE i.business_id = p_business_id AND i.id = p_invoice_id $fn$`,
  },
  {
    sig: 'invoice_settlement_state(uuid,uuid)',
    create: `CREATE FUNCTION invoice_settlement_state(p_business_id UUID, p_invoice_id UUID) RETURNS TEXT
               LANGUAGE sql STABLE SET search_path = ${PINNED_PATH}
               AS $fn$ SELECT CASE WHEN public.invoice_outstanding(p_business_id, p_invoice_id) = 0 THEN 'settled' ELSE 'open' END $fn$`,
  },
  {
    sig: 'customer_ar_outstanding(uuid,uuid)',
    create: `CREATE FUNCTION customer_ar_outstanding(p_business_id UUID, p_customer_id UUID) RETURNS BIGINT
               LANGUAGE sql STABLE SET search_path = ${PINNED_PATH}
               AS $fn$ SELECT coalesce(sum(i.total_minor), 0)::BIGINT FROM public.invoices i
                        WHERE i.business_id = p_business_id AND i.customer_id = p_customer_id $fn$`,
  },
  {
    sig: 'customer_ar_aging(uuid,uuid,date,integer[])',
    create: `CREATE FUNCTION customer_ar_aging(p_business_id UUID, p_customer_id UUID, p_as_of DATE, p_buckets INTEGER[])
               RETURNS TABLE (bucket INTEGER, amount_minor BIGINT)
               LANGUAGE sql STABLE SET search_path = ${PINNED_PATH}
               AS $fn$ SELECT b.bucket, coalesce(sum(i.total_minor), 0)::BIGINT
                         FROM unnest(p_buckets) AS b(bucket)
                         LEFT JOIN public.invoices i
                           ON i.business_id = p_business_id AND i.customer_id = p_customer_id AND i.issued_on <= p_as_of
                        GROUP BY b.bucket $fn$`,
  },
];

/**
 * Every statement that creates the fixture, in order: the relations with
 * their RLS, their `REVOKE ALL … FROM PUBLIC` and no runtime grant, then the
 * four routines with their pinned path, their internal owner and their
 * `REVOKE ALL … FROM PUBLIC`.
 */
export function probeStatements(): string[] {
  const out: string[] = [...TABLE_DDL];
  for (const relation of PROBE_RELATIONS) {
    out.push(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY`);
    out.push(`ALTER TABLE ${relation} FORCE ROW LEVEL SECURITY`);
    out.push(`REVOKE ALL ON TABLE ${relation} FROM PUBLIC`);
    for (const reader of PROBE_TABLE_READERS) out.push(`GRANT SELECT ON TABLE ${relation} TO ${reader}`);
  }
  out.push(`GRANT SELECT ON TABLE invoices TO daftar_accounting_internal`);
  for (const r of ROUTINE_DDL) {
    out.push(r.create);
    out.push(`REVOKE ALL ON FUNCTION ${r.sig} FROM PUBLIC`);
    for (const reader of PROBE_ROUTINE_READERS) out.push(`GRANT EXECUTE ON FUNCTION ${r.sig} TO ${reader}`);
  }
  // One DEFINER trigger function with an internal owner and no EXECUTE
  // grantee but its own: the shape the migration's guard functions have, and
  // the subject the definer-law red proofs need.
  out.push(`CREATE FUNCTION invoices_probe_lifecycle_guard() RETURNS TRIGGER
              LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${PINNED_PATH}
              AS $fn$ BEGIN RETURN NEW; END $fn$`);
  out.push(`ALTER FUNCTION invoices_probe_lifecycle_guard() OWNER TO ${PROBE_TRIGGER_OWNER}`);
  out.push(`REVOKE ALL ON FUNCTION invoices_probe_lifecycle_guard() FROM PUBLIC`);
  out.push(`CREATE TRIGGER invoices_probe_lifecycle BEFORE UPDATE ON invoices
              FOR EACH ROW EXECUTE FUNCTION invoices_probe_lifecycle_guard()`);
  return out;
}

/** The DEFINER trigger function the fixture creates, for the clause red proofs. */
export const PROBE_DEFINER_ROUTINE = 'invoices_probe_lifecycle_guard()';
