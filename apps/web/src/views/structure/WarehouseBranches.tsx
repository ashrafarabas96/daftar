/**
 * "Also serves branches" under each warehouse (P3-S7 A-11, A-05) —
 * `POST`/`DELETE …/warehouses/:warehouseId/branches`.
 *
 * A warehouse always serves its own branch; the merchant may let it serve
 * others too, so members of those branches can use its stock. The command
 * states the end state (`changed: false` on a repeat) and needs access to
 * every branch; the server decides and its refusal is shown.
 */
import { Badge, Button, Card, List } from '@daftar/design-system';
import type { InventoryWarehouseDto } from '@/lib/phase3-api';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { Hint, Notice, STACK, SectionTitle } from '../stock/parts';

export interface WarehouseBranchesProps {
  warehouses: readonly InventoryWarehouseDto[];
  branches: readonly { id: string; name: string }[];
  /** `warehouseId:branchId` of the change in flight. */
  busyKey: string | null;
  errorKey: string | null;
  onAdd: (warehouseId: string, branchId: string) => void;
  onRemove: (warehouseId: string, branchId: string) => void;
}

export function WarehouseBranches(props: WarehouseBranchesProps & ViewBaseProps) {
  const { t } = props;
  return (
    <div style={STACK}>
      <SectionTitle>{t('stock.reach.title')}</SectionTitle>
      <Hint>{t('stock.reach.intro')}</Hint>
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      {props.warehouses
        .filter((w) => w.status === 'active')
        .map((w) => (
          <Card key={w.warehouseId}>
            <div style={STACK}>
              <strong>
                <bdi>{w.name}</bdi>
              </strong>
              <List
                items={props.branches.map((b) => {
                  const busy = props.busyKey === `${w.warehouseId}:${b.id}`;
                  const serves = w.branchIds.includes(b.id);
                  return {
                    key: b.id,
                    primary: <bdi>{b.name}</bdi>,
                    secondary: b.id === w.homeBranchId ? t('stock.reach.home') : serves ? t('stock.reach.serves') : t('stock.reach.notServed'),
                    trailing:
                      b.id === w.homeBranchId ? (
                        <Badge tone="brand">{t('stock.reach.homeBadge')}</Badge>
                      ) : serves ? (
                        <Button variant="secondary" loading={busy} disabled={props.busyKey !== null} onClick={() => props.onRemove(w.warehouseId, b.id)}>
                          {t('stock.reach.remove')}
                        </Button>
                      ) : (
                        <Button variant="secondary" loading={busy} disabled={props.busyKey !== null} onClick={() => props.onAdd(w.warehouseId, b.id)}>
                          {t('stock.reach.add')}
                        </Button>
                      ),
                  };
                })}
              />
            </div>
          </Card>
        ))}
    </div>
  );
}
