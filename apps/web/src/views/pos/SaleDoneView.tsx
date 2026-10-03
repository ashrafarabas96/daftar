/**
 * The sale the server recorded (P4-S3): what was sold, and the three amounts
 * the server wrote down. The screen reads the sale back and shows it; it
 * computes nothing.
 *
 * ── THE RECEIPT IS A `SaleDto`, NOT A POS TYPE ───────────────────────────
 * Finishing a sale at the till IS `POST /v1/sales`, P4-S2's atomic commit, so
 * what comes back is that slice's own answer and this screen reads it directly:
 *
 *   number     → `sale.invoice.number.documentNumber`  (the database rendered it)
 *   per line   → `nameSnapshot`, `quantity`, `netTxnMinor`
 *   items      → `sale.subtotalTxnMinor`
 *   discount   → `sale.discountTxnMinor`
 *   to pay     → `sale.totalTxnMinor`
 *   currency   → `sale.currencyCode`  (the server resolved it)
 *
 * ── WHAT A `SaleDto` CARRIES AND NO RENDER HERE EMITS (A-13) ─────────────
 * `cogsBaseMinor`, `totalBaseMinor`, `sourceToBaseRate`, `rateSource`,
 * `rateTimestamp`, `branchId`, `warehouseId`, `saleId`, `status`,
 * `settlementMode`, `replayed`, `invoice.invoiceId` and each line's
 * `lineId`/`lineNo`/`baseShareMinor`/`taxMinor`. The merchant reads what was
 * sold and what it came to, not the engine's identities, the ledger's cost or
 * the FX snapshot — and `apps/web/test/pos-receipt-invisible.test.tsx` plants
 * every one of them on the fixture and proves no render emits it, in all three
 * locales. The old `PosSaleReceiptDto` carried `businessTransactionId` and
 * `movementIds` instead, which `SaleDto` does not have at all.
 *
 * `taxMinor` is likewise not shown: structurally zero (`P4-AL-44`, `OD-03`
 * OPEN), and a "Tax 0.00" row on a receipt would state a tax policy.
 */
import { Button, Card, List } from '@daftar/design-system';
import { Ltr, rich, type ViewBaseProps } from '@/lib/phase3-format';
import type { SaleDto } from '@/lib/phase4-pos-api';
import { Heading, Money, Notice, Quantity, Stack, Title } from '../common/primitives';
import { POS_STACK, PosItemName, PosTotals } from './parts';

export interface SaleDoneViewProps {
  sale: SaleDto;
  onAnother: () => void;
  onGoToTill: () => void;
}

export function SaleDoneView(props: SaleDoneViewProps & ViewBaseProps) {
  const { t, locale, sale } = props;
  return (
    <div style={POS_STACK}>
      <Title>{t('pos.title')}</Title>
      <Notice tone="success">{t('pos.finish.done')}</Notice>
      <Heading>{rich(t('pos.receipt.number'), { number: <Ltr>{sale.invoice.number.documentNumber}</Ltr> })}</Heading>
      <Heading>{t('pos.receipt.title')}</Heading>
      <Card>
        <List
          items={sale.lines.map((line) => ({
            // The line's own id is NOT rendered; it is the React key, which
            // never reaches the markup.
            key: line.lineId,
            primary: <PosItemName name={line.nameSnapshot} />,
            trailing: (
              <Stack gap={1}>
                {/*
                 * `decimals={0}`: a `SaleLineDto` carries no unit precision, so
                 * the screen re-spells the exact decimal text the server sent
                 * and pads it to nothing it cannot know.
                 */}
                <Quantity value={line.quantity} decimals={0} locale={locale} />
                <Money amountMinor={line.netTxnMinor} currency={sale.currencyCode} locale={locale} />
              </Stack>
            ),
          }))}
        />
      </Card>
      <Card>
        <PosTotals
          t={t}
          locale={locale}
          currency={sale.currencyCode}
          subtotalMinor={sale.subtotalTxnMinor}
          discountMinor={sale.discountTxnMinor}
          totalMinor={sale.totalTxnMinor}
        />
      </Card>
      <Button fullWidth onClick={props.onAnother}>
        {t('pos.finish.another')}
      </Button>
      <Button variant="ghost" fullWidth onClick={props.onGoToTill}>
        {t('pos.till.goToTill')}
      </Button>
    </div>
  );
}
