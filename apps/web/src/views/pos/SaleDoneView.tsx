/**
 * The sale the server recorded (P4-S3): what was sold, and the three amounts
 * the server wrote down. The screen reads the sale back and shows it; it
 * computes nothing and it shows no identity of its own — the sale id, the
 * trace id and the journal entry the sale produced are never rendered.
 */
import { Button, Card, List } from '@daftar/design-system';
import { Ltr, rich, type ViewBaseProps } from '@/lib/phase3-format';
import type { PosSaleReceiptDto } from '@/lib/phase4-pos-api';
import { Heading, Money, Notice, Quantity, Stack, Title } from '../common/primitives';
import { POS_STACK, PosItemName, PosTotals } from './parts';

export interface SaleDoneViewProps {
  sale: PosSaleReceiptDto;
  unitNames: Readonly<Record<string, string>>;
  onAnother: () => void;
  onGoToTill: () => void;
}

export function SaleDoneView(props: SaleDoneViewProps & ViewBaseProps) {
  const { t, locale, sale } = props;
  return (
    <div style={POS_STACK}>
      <Title>{t('pos.title')}</Title>
      <Notice tone="success">{t('pos.finish.done')}</Notice>
      <Heading>{rich(t('pos.receipt.number'), { number: <Ltr>{sale.receiptNumber}</Ltr> })}</Heading>
      <Heading>{t('pos.receipt.title')}</Heading>
      <Card>
        <List
          items={sale.lines.map((line) => ({
            key: line.lineId,
            primary: <PosItemName name={line.name} variantName={line.variantName} />,
            secondary: line.unitCode === null ? undefined : (props.unitNames[line.unitCode] ?? line.unitCode),
            trailing: (
              <Stack gap={1}>
                <Quantity value={line.quantity} decimals={line.unitDecimals} locale={locale} />
                <Money amountMinor={line.lineTotalMinor} currency={sale.currency} locale={locale} />
              </Stack>
            ),
          }))}
        />
      </Card>
      <Card>
        <PosTotals
          t={t}
          locale={locale}
          currency={sale.currency}
          subtotalMinor={sale.subtotalMinor}
          discountMinor={sale.discountMinor}
          totalMinor={sale.totalMinor}
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
