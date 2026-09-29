/**
 * P3-S4 T-03 — THE SUPPLIER LIFECYCLE
 * (docs/PHASE_3_S4_CONTRACT.md A-04, A-11, TL-3, §6 T-03; L:1191-1200).
 *
 * - create → update → archive → reactivate, one revision each, each audited
 *   once; the identical command replays (no second audit); the same supplier
 *   id with other fields is `supplier.idempotency_conflict`;
 * - a stale revision is `supplier.revision_changed`, sequentially and in a
 *   real two-connection race; archive of an inactive and reactivate of an
 *   active supplier are `supplier.state_invalid`;
 * - a supplier is never deleted: the owner's own DELETE hits the trigger
 *   (`supplier.not_deletable`), and behind it the RESTRICT foreign key of a
 *   purchase (its SQLSTATE derived from `server_version_num`); the internal
 *   principal holds no DELETE; identity columns are final;
 * - an inactive supplier is refused by a draft and by a receipt
 *   (`purchase.supplier_inactive`); a receipt prepared before the supplier
 *   moved is `purchase.supplier_changed`;
 * - the receipt snapshots name, tax identifier and phone, and a later update
 *   of the supplier leaves the snapshot byte-identical.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  attempt,
  expectAccepted,
  expectConstraint,
  isBlocked,
  must,
  ownerClient,
  pidOf,
  refusedWith,
  restrictSqlstate,
  scratch,
  seedS3World,
  waitUntilBlocked,
  type S3World,
} from '../helpers/inventory-commands';
import {
  FULL_CONTACTS,
  createSupplier,
  draftAndReceive,
  honestDraft,
  prepareReceipt,
  runCommand,
  s4Counts,
  s4Delta,
  supplierArchive,
  supplierCreate,
  supplierIn,
  supplierReactivate,
  supplierUpdate,
  tryCommand,
} from '../helpers/purchase-commands';

let world: S3World;
let c: Client;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world = await seedS3World(ownerPool(), 's4sup');
});

afterAll(async () => {
  await resetData();
});

async function inTx(fn: () => Promise<void>): Promise<void> {
  c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn();
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

interface SupplierRow {
  name: string;
  phone: string | null;
  email: string | null;
  tax_identifier: string | null;
  notes: string | null;
  status: string;
  revision: number;
}

async function supplierRow(q: { query: Client['query'] }, businessId: string, id: string): Promise<SupplierRow> {
  return must(
    (
      await q.query<SupplierRow>(`SELECT name, phone, email, tax_identifier, notes, status, revision FROM suppliers WHERE business_id = $1 AND id = $2`, [
        businessId,
        id,
      ])
    ).rows[0],
    `supplier ${id}`,
  );
}

async function audits(businessId: string, id: string): Promise<string[]> {
  const r = await c.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE business_id = $1 AND entity = 'supplier' AND entity_id = $2 ORDER BY created_at, action`,
    [businessId, id],
  );
  return r.rows.map((x) => x.action);
}

describe('T-03 lifecycle, replay and conflict', () => {
  it('create → update → archive → reactivate: one revision and one audit each; each identical command replays', async () => {
    await inTx(async () => {
      const A = world.A;
      const create = supplierCreate(FULL_CONTACTS);
      const created = must(expectAccepted(await tryCommand(c, A, create))[0]);
      expect({ replayed: created.replayed, revision: created.revision, status: created.status }).toEqual({ replayed: false, revision: 1, status: 'active' });
      expect(await supplierRow(c, A.businessId, create.supplierId)).toEqual({
        name: FULL_CONTACTS.name,
        phone: FULL_CONTACTS.phone,
        email: FULL_CONTACTS.email,
        tax_identifier: FULL_CONTACTS.taxIdentifier,
        notes: FULL_CONTACTS.notes,
        status: 'active',
        revision: 1,
      });

      const update = supplierUpdate(create.supplierId, 1, { ...FULL_CONTACTS, name: 'Hebron Glass Works', phone: null, notes: null });
      const archive = supplierArchive(create.supplierId, 2);
      const reactivate = supplierReactivate(create.supplierId, 3);
      expect(must(expectAccepted(await tryCommand(c, A, update))[0]).revision).toBe(2);
      expect(await supplierRow(c, A.businessId, create.supplierId)).toMatchObject({ name: 'Hebron Glass Works', phone: null, notes: null, revision: 2 });
      expect(must(expectAccepted(await tryCommand(c, A, archive))[0])).toMatchObject({ revision: 3, status: 'inactive', replayed: false });
      expect(must(expectAccepted(await tryCommand(c, A, reactivate))[0])).toMatchObject({ revision: 4, status: 'active', replayed: false });
      expect(await audits(A.businessId, create.supplierId)).toEqual(
        ['supplier.created', 'supplier.updated', 'supplier.archived', 'supplier.reactivated'].sort(),
      );

      const before = await s4Counts(c, A.businessId);
      for (const cmd of [create, reactivate]) {
        expect(must(expectAccepted(await tryCommand(c, A, cmd), cmd.kind)[0]).replayed, `${cmd.kind} replays`).toBe(true);
      }
      expect(s4Delta(before, await s4Counts(c, A.businessId)), 'a replay writes nothing but its assertion use').toEqual({ inventory_assertion_uses: 2 });
    });
  });

  it('the same supplier id with other fields → supplier.idempotency_conflict; an older command after a newer one → revision_changed', async () => {
    await inTx(async () => {
      const A = world.A;
      const create = supplierCreate(FULL_CONTACTS);
      await runCommand(c, A, create);
      refusedWith(
        await tryCommand(c, A, supplierCreate({ ...FULL_CONTACTS, name: 'Someone else' }, create.supplierId)),
        'P0001',
        'supplier.idempotency_conflict',
      );
      await runCommand(c, A, supplierUpdate(create.supplierId, 1, { ...FULL_CONTACTS, name: 'First edit' }));
      refusedWith(
        await tryCommand(c, A, supplierUpdate(create.supplierId, 1, { ...FULL_CONTACTS, name: 'Second edit' })),
        'P0001',
        'supplier.revision_changed',
      );
      refusedWith(await tryCommand(c, A, supplierArchive(create.supplierId, 1)), 'P0001', 'supplier.revision_changed');
      refusedWith(
        await tryCommand(c, A, supplierUpdate(create.supplierId, 3, { ...FULL_CONTACTS })),
        'P0001',
        'supplier.revision_changed',
        'a revision from the future',
      );
      refusedWith(await tryCommand(c, A, supplierReactivate(create.supplierId, 2)), 'P0001', 'supplier.state_invalid', 'reactivate an active supplier');
      await runCommand(c, A, supplierArchive(create.supplierId, 2));
      refusedWith(await tryCommand(c, A, supplierArchive(create.supplierId, 3)), 'P0001', 'supplier.state_invalid', 'archive an inactive supplier');
      refusedWith(await tryCommand(c, A, supplierUpdate(randomUUID(), 1, FULL_CONTACTS)), 'P0001', 'supplier.not_found');
      expect(await supplierRow(c, A.businessId, create.supplierId)).toMatchObject({ name: 'First edit', status: 'inactive', revision: 3 });
    });
  });

  it('a revision race on two real connections: the second writer waits on the supplier key, then is refused revision_changed', async () => {
    const A = world.A;
    const id = await supplierIn(ownerPool(), A, FULL_CONTACTS);
    const c1 = await ownerClient();
    const c2 = await ownerClient();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const pid2 = await pidOf(c2);
      await runCommand(c1, A, supplierUpdate(id, 1, { ...FULL_CONTACTS, name: 'Writer one' }));
      const second = tryCommand(c2, A, supplierUpdate(id, 1, { ...FULL_CONTACTS, name: 'Writer two' }));
      await waitUntilBlocked(pid2, 'the second supplier update');
      expect(await isBlocked(pid2), 'the second writer waits for the first').toBe(true);
      await c1.query('COMMIT');
      refusedWith(await second, 'P0001', 'supplier.revision_changed');
      await c2.query('ROLLBACK');
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(await supplierRow(ownerPool(), A.businessId, id)).toMatchObject({ name: 'Writer one', revision: 2 });
  });
});

describe('T-03 a supplier is never deleted', () => {
  it('the owner’s DELETE → supplier.not_deletable; behind the trigger, a purchase’s RESTRICT FK; the internal principal holds no DELETE', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await createSupplier(c, A, FULL_CONTACTS);
      refusedWith(
        await attempt(c, () => c.query(`DELETE FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, id])),
        'P0001',
        'supplier.not_deletable',
      );
      await runCommand(c, A, await honestDraft(c, A, id));
      const restrict = await restrictSqlstate(c);
      await scratch(c, async () => {
        await c.query('ALTER TABLE suppliers DISABLE TRIGGER suppliers_no_delete');
        expectConstraint(
          await attempt(c, () => c.query(`DELETE FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, id])),
          restrict,
          'purchases_supplier_fk',
          'a supplier with a purchase',
        );
      });
      refusedWith(
        await attempt(c, async () => {
          await c.query('SET LOCAL ROLE daftar_inventory_internal');
          await c.query(`DELETE FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, id]);
        }),
        '42501',
        null,
        'the internal principal',
      );
      expect((await c.query(`SELECT 1 FROM suppliers WHERE business_id = $1 AND id = $2`, [A.businessId, id])).rowCount).toBe(1);
    });
  });

  it('identity columns are final and a revision moves one step at a time, as owner too', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await createSupplier(c, A, FULL_CONTACTS);
      for (const set of [
        `id = gen_random_uuid()`,
        `created_by = updated_by, created_at = created_at - interval '1 day'`,
        `create_intent_sha256 = repeat('0', 64)`,
      ]) {
        refusedWith(
          await attempt(c, () => c.query(`UPDATE suppliers SET ${set}, revision = revision + 1 WHERE business_id = $1 AND id = $2`, [A.businessId, id])),
          'P0001',
          'supplier.state_invalid',
          set,
        );
      }
      refusedWith(
        await attempt(c, () => c.query(`UPDATE suppliers SET name = 'Skip', revision = revision + 2 WHERE business_id = $1 AND id = $2`, [A.businessId, id])),
        'P0001',
        'supplier.revision_changed',
      );
      refusedWith(
        await attempt(c, () => c.query(`UPDATE suppliers SET name = 'Same' WHERE business_id = $1 AND id = $2`, [A.businessId, id])),
        'P0001',
        'supplier.revision_changed',
      );
    });
  });
});

describe('T-03 an inactive supplier takes no purchase; the receipt snapshots the supplier', () => {
  it('a draft for an archived supplier → purchase.supplier_inactive; reactivated, the same draft is accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await createSupplier(c, A, FULL_CONTACTS);
      await runCommand(c, A, supplierArchive(id, 1));
      const draft = await honestDraft(c, A, id);
      const before = await s4Counts(c, A.businessId);
      refusedWith(await tryCommand(c, A, draft), 'P0001', 'purchase.supplier_inactive');
      expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
      await runCommand(c, A, supplierReactivate(id, 2));
      expectAccepted(await tryCommand(c, A, draft));
    });
  });

  it('a receipt after the supplier was archived → supplier_inactive; prepared before it moved → supplier_changed; reactivated → accepted', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await createSupplier(c, A, FULL_CONTACTS);
      const draft = await honestDraft(c, A, id);
      await runCommand(c, A, draft);
      const stale = await prepareReceipt(c, A, draft.purchaseId);
      await runCommand(c, A, supplierArchive(id, 1));
      const before = await s4Counts(c, A.businessId);
      refusedWith(await tryCommand(c, A, stale.cmd), 'P0001', 'purchase.supplier_changed', 'prepared at revision 1');
      refusedWith(await tryCommand(c, A, (await prepareReceipt(c, A, draft.purchaseId)).cmd), 'P0001', 'purchase.supplier_inactive');
      expect(s4Delta(before, await s4Counts(c, A.businessId))).toEqual({});
      await runCommand(c, A, supplierReactivate(id, 2));
      refusedWith(await tryCommand(c, A, stale.cmd), 'P0001', 'purchase.supplier_changed', 'revision 3 now');
      expectAccepted(await tryCommand(c, A, (await prepareReceipt(c, A, draft.purchaseId)).cmd));
    });
  });

  it('the receipt snapshots name, tax identifier and phone; a later update leaves the snapshot unchanged', async () => {
    await inTx(async () => {
      const A = world.A;
      const id = await createSupplier(c, A, FULL_CONTACTS);
      const run = await draftAndReceive(c, A, await honestDraft(c, A, id));
      const snap = async (): Promise<Record<string, unknown>> =>
        must(
          (
            await c.query<Record<string, unknown>>(
              `SELECT supplier_id::text, supplier_name_snapshot, supplier_tax_identifier_snapshot, supplier_phone_snapshot, status, total_base_minor::text
                 FROM purchases WHERE business_id = $1 AND id = $2`,
              [A.businessId, run.prepared.cmd.purchaseId],
            )
          ).rows[0],
        );
      const atReceipt = await snap();
      expect(atReceipt).toEqual({
        supplier_id: id,
        supplier_name_snapshot: FULL_CONTACTS.name,
        supplier_tax_identifier_snapshot: FULL_CONTACTS.taxIdentifier,
        supplier_phone_snapshot: FULL_CONTACTS.phone,
        status: 'received',
        total_base_minor: run.prepared.cmd.totalBaseMinor.toString(),
      });
      await runCommand(c, A, supplierUpdate(id, 1, { name: 'Renamed Supplier Ltd', phone: '+970 2 000 0000', email: null, taxIdentifier: null, notes: null }));
      await runCommand(c, A, supplierArchive(id, 2));
      expect(await snap(), 'the received document keeps what the supplier was').toEqual(atReceipt);
    });
  });
});
