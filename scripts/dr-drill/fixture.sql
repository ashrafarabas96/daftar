-- dr-drill fixture — fictional financial data for the disaster-recovery drill.
--
-- It exists so the drill has money to lose: a balanced journal entry over two
-- accounts of one business of one tenant. The names, the e-mail and the hash
-- are invented and belong to nobody; the hash is not a hash of anything.
--
-- It is applied to a database that already carries every migration, and it
-- needs a principal that can see and write past row-level security: this
-- schema sets FORCE ROW LEVEL SECURITY on these tables and grants INSERT on
-- the journal to no role at all (0042_accounting_journal.sql), so in practice
-- only a superuser can apply it. That is a property of the fixture, not a
-- recommendation: a managed production database offers no such principal, and
-- a production drill therefore starts from a real snapshot and never from here.
--
-- And what it inserts is rows, not posted truth: it writes the journal
-- directly instead of going through accounting_post_entry
-- (0045_accounting_post_entry.sql), and its posting fingerprint is invented.
-- So the claim the drill may rest on it is "the restore kept what was put in",
-- never "the restore kept a financial fact that the posting authority
-- produced".
--
-- Usage:
--   psql -v ON_ERROR_STOP=1 --single-transaction -d <db> -f scripts/dr-drill/fixture.sql
--
-- It carries no BEGIN of its own: --single-transaction is what makes it all
-- or nothing, and a nested BEGIN would only warn.

INSERT INTO tenants (id)
VALUES ('11111111-1111-4111-8111-111111111111');

INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, timezone)
VALUES ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'Drill Shop', 'dr-drill-shop', 'PS', 'ILS', 'Asia/Jerusalem');

INSERT INTO users (id, email, password_hash, display_name)
VALUES ('33333333-3333-4333-8333-333333333333',
        'dr-drill-owner@example.test',
        'not-a-hash-this-row-is-a-fixture',
        'Drill Owner');

-- The chart of accounts is seeded by the schema itself when the business is
-- created (accounting_seed_chart), so the fixture does not insert accounts: it
-- picks two of the seeded ones, one asset and one revenue.

INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, description,
                             source_type, source_id, actor_kind, actor_user_id,
                             posting_fingerprint)
VALUES ('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '55555555-5555-4555-8555-555555555555',
        DATE '2026-01-15',
        'dr-drill fixture entry',
        'manual_adjustment',
        '66666666-6666-4666-8666-666666666666',
        'user',
        '33333333-3333-4333-8333-333333333333',
        repeat('a', 64));

-- A manual adjustment also carries its own detail row, or the schema refuses
-- the entry at COMMIT (accounting_manual_adjustment_entry_complete).
INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id)
VALUES ('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '66666666-6666-4666-8666-666666666666',
        'dr-drill fixture: a balanced entry for the restore comparison',
        '33333333-3333-4333-8333-333333333333');

-- The schema refuses an entry that reaches COMMIT without a registered source
-- identity (journal_entries_binding_fk, deferred), so the binding is part of
-- the same transaction.
INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id)
VALUES ('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'manual_adjustment',
        '66666666-6666-4666-8666-666666666666',
        '55555555-5555-4555-8555-555555555555');

-- 1,500.00 ILS debited and 1,500.00 ILS credited: the entry balances, which is
-- what INV-ACC-01 asserts and what the drill re-asserts after the restore.
INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id,
                           debit_minor, credit_minor, base_amount_minor, base_currency,
                           txn_currency, txn_amount_minor, fx_rate, fx_rate_source, fx_rate_at)
SELECT '11111111-1111-4111-8111-111111111111',
       '22222222-2222-4222-8222-222222222222',
       line.id, '55555555-5555-4555-8555-555555555555', line.no,
       (SELECT a.id FROM accounts a
         WHERE a.business_id = '22222222-2222-4222-8222-222222222222'
           AND a.type = line.account_type
         ORDER BY a.code
         LIMIT 1),
       line.debit, line.credit, 150000, 'ILS', 'ILS', 150000, 1.0, 'base',
       TIMESTAMPTZ '2026-01-15 09:00:00+00'
FROM (VALUES ('77777777-0000-4000-8000-000000000001'::uuid, 1, 'asset',   150000::bigint, 0::bigint),
             ('77777777-0000-4000-8000-000000000002'::uuid, 2, 'revenue', 0::bigint,      150000::bigint))
     AS line(id, no, account_type, debit, credit);
