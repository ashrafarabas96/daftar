/**
 * Planted views for the SSR suites' own proof (T-08, T-15, T-16): one view
 * that obeys every rule, and one per rule that breaks exactly that rule. The
 * suites run the real `VIEW_REGISTRY` entries; these show the rules can fail.
 * They live under test/, so neither the Next build nor Rule 23 sees them.
 */
import { Button, Card, Checkbox, List, Select, Table, TextField } from '@daftar/design-system';
import { Ltr, defineView, formatQty, rich, type ViewBaseProps } from '@/lib/phase3-format';

/** A stock row as a view receives it, with the hidden fields a real DTO or command result carries. */
export interface ProbeRow {
  productId: string;
  variantId: string | null;
  name: string;
  onHand: string;
  unitDecimals: number;
  businessTransactionId: string;
  journalEntryId: string | null;
  lastStockSeq: string;
  baseVariantId: string;
  postingAccountId: string;
}

export const PROBE_ROW: ProbeRow = {
  productId: '5a1f0c4e-1111-4c2b-9a0d-000000000001',
  variantId: null,
  name: 'Olive oil',
  onHand: '-3.5',
  unitDecimals: 2,
  businessTransactionId: 'b7d3a2c1-2222-4c2b-9a0d-00000000bt01',
  journalEntryId: 'e9e9e9e9-3333-4c2b-9a0d-00000000je01',
  lastStockSeq: '987654321012',
  baseVariantId: 'ba5eba5e-4444-4c2b-9a0d-00000000bv01',
  postingAccountId: 'acc0acc0-5555-4c2b-9a0d-00000000pa01',
};

type Props = { row: ProbeRow } & ViewBaseProps;

/** Obeys every rule: DS primitives, catalog text, numbers in <bdi>, logical properties, nothing hidden rendered. */
export function GoodProbe({ row, t, locale }: Props) {
  return (
    <Card>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', gap: '1rem', marginInlineStart: '0.5rem' }}>
        <List
          items={[
            {
              key: row.productId,
              primary: row.name,
              secondary: rich(t('common.quantity'), {}),
              trailing: <Ltr>{formatQty(row.onHand, row.unitDecimals, locale)}</Ltr>,
            },
          ]}
        />
        <TextField label={t('common.search')} />
        <Select label={t('common.warehouse')} options={[{ value: 'w1', label: 'Main store' }]} />
        <Checkbox label={t('common.optional')} checked={false} onChange={() => undefined} />
        <Button fullWidth>{t('common.save')}</Button>
      </div>
    </Card>
  );
}

export const LeakProbe = ({ row, t }: Props) => (
  <p>
    {t('common.done')} <Ltr>{row.businessTransactionId}</Ltr>
  </p>
);
export const WideProbe = ({ t }: Props) => <div style={{ width: '25rem' }}>{t('common.done')}</div>;
export const ViewportProbe = ({ t }: Props) => <div style={{ width: '100vw' }}>{t('common.done')}</div>;
export const TableProbe = ({ row }: Props) => <Table columns={[{ key: 'n', header: 'n', render: (r: { id: string }) => r.id }]} rows={[{ id: row.name }]} />;
export const SmallButtonProbe = ({ t }: Props) => <Button size="sm">{t('common.done')}</Button>;
export const RawButtonProbe = ({ t }: Props) => <button type="button">{t('common.done')}</button>;
export const DigitsProbe = ({ row, t }: Props) => (
  <p>
    {t('common.quantity')} {row.onHand}
  </p>
);
export const MissingKeyProbe = ({ t }: Props) => <p>{t('stock.no_such_key_in_any_catalog')}</p>;
export const PhysicalProbe = ({ t }: Props) => <p style={{ marginLeft: '1rem', textAlign: 'left' }}>{t('common.done')}</p>;
export const LocaleBranchProbe = ({ t, locale }: Props) => (locale === 'ar' ? <section>{t('common.done')}</section> : <p>{t('common.done')}</p>);

const fixtures = { 'negative stock': { row: PROBE_ROW } };

export const GOOD_PROBES = [defineView('GoodProbe', GoodProbe, fixtures)];

/** Each planted view and the rule family it must trip. */
export const BAD_PROBES = {
  leak: defineView('LeakProbe', LeakProbe, fixtures),
  wide: defineView('WideProbe', WideProbe, fixtures),
  viewport: defineView('ViewportProbe', ViewportProbe, fixtures),
  table: defineView('TableProbe', TableProbe, fixtures),
  smallButton: defineView('SmallButtonProbe', SmallButtonProbe, fixtures),
  rawButton: defineView('RawButtonProbe', RawButtonProbe, fixtures),
  digits: defineView('DigitsProbe', DigitsProbe, fixtures),
  missingKey: defineView('MissingKeyProbe', MissingKeyProbe, fixtures),
  physical: defineView('PhysicalProbe', PhysicalProbe, fixtures),
  localeBranch: defineView('LocaleBranchProbe', LocaleBranchProbe, fixtures),
};
