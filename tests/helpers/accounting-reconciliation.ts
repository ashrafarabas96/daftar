import type { Pool, PoolClient } from 'pg';
import type { ReconciliationConnection } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';

/**
 * A reconciliation connection backed by ANY pool the test supplies.
 *
 * Two suites need this for different reasons and neither is a shortcut.
 *
 * The check suite needs a credential that can see the whole system, so that
 * what is being tested is the SQL of the nine checks rather than the reach of
 * the worker's grants — the worker's reach is asserted separately, and is a
 * finding in its own right.
 *
 * The planted-discrepancy suite (§23) needs the schema owner on a THROWAWAY
 * database, because the corruption those tests look for is corruption the
 * frozen constraints make impossible through ordinary SQL. Planting it means
 * dropping a constraint on a database that is destroyed afterwards, which is
 * test authority over a disposable object — never a bypass in the product.
 */
export class PoolReconciliationConnection implements ReconciliationConnection {
  constructor(private readonly pool: Pool) {}

  async unscoped<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.run(null, fn);
  }

  async scoped<T>(tenantId: string, businessId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.run({ tenantId, businessId }, fn);
  }

  private async run<T>(scope: { tenantId: string; businessId: string } | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (scope) {
        await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
