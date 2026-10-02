/**
 * The till (P4-S3): open the one till this cashier sells from, see it, count
 * it and close it. `OD-P4-09` is RULED — one session, one authenticated user —
 * so the screen offers exactly one till and never a list of other people's,
 * and it has no way to say WHOSE till it is opening: the owner is not a field.
 *
 * The two amounts here are the cash the cashier COUNTS and states — the money
 * in the drawer at the start of the shift, and the money counted at the end.
 * Both are typed in major units and turned into integer minor units by the
 * page's `amountInputToMinor` (BigInt) before they are sent. The screen shows
 * no expected figure and no difference: both are the server's to derive.
 */
import { Button, ConfirmationDialog, Select, TextField } from '@daftar/design-system';
import { rich, type ViewBaseProps } from '@/lib/phase3-format';
import { CivilDate, Fact, Heading, Money, Muted, Notice, Stack, Title } from '../common/primitives';
import { RefusalNotice } from '../common/feedback';
import { POS_STACK } from './parts';

/** A place a till may be opened in, as `GET /v1/businesses/current/branches` answers. */
export interface PosBranchOption {
  id: string;
  name: string;
}

export interface TillViewProps {
  branches: readonly PosBranchOption[];
  branchId: string;
  /** The open till, as the server answered, or null when this user has none. */
  session: {
    tillSessionId: string;
    branchId: string;
    status: 'open' | 'closed';
    openedAt: string;
    closedAt: string | null;
    openingFloatMinor: string;
    closingCountMinor: string | null;
  } | null;
  /** The currency the till is counted in — the business's own. */
  currency: string | null;
  /** What the cashier typed as the cash in the drawer, and as the cash counted at the close. */
  openingFloatText: string;
  closingCountText: string;
  openingFloatInvalid: boolean;
  closingCountInvalid: boolean;
  /** True once this screen's own close has been accepted, so the page can say so. */
  justClosed: boolean;
  confirmingClose: boolean;
  busy: boolean;
  errorKey: string | null;
  onBranch: (branchId: string) => void;
  onOpeningFloat: (value: string) => void;
  onClosingCount: (value: string) => void;
  onOpen: () => void;
  onAskClose: () => void;
  onCancelClose: () => void;
  onClose: () => void;
  onBackToSelling: () => void;
}

export function TillView(props: TillViewProps & ViewBaseProps) {
  const { t, locale, session } = props;
  const currency = props.currency ?? '';
  const options = [{ value: '', label: t('pos.till.chooseBranch') }, ...props.branches.map((b) => ({ value: b.id, label: b.name }))];
  const placeName = props.branches.find((b) => b.id === (session?.branchId ?? props.branchId))?.name ?? '';
  return (
    <div style={POS_STACK}>
      <Title>{t('pos.till.title')}</Title>
      {session !== null ? (
        <Stack gap={4}>
          <Notice tone="success">{t('pos.till.opened')}</Notice>
          <Heading>{t('pos.till.where')}</Heading>
          <Stack gap={2}>
            <bdi>{placeName}</bdi>
            <Muted>{rich(t('pos.till.openedOn'), { date: <CivilDate iso={session.openedAt} locale={locale} /> })}</Muted>
          </Stack>
          <Fact label={t('pos.till.floatInDrawer')}>
            <Money amountMinor={session.openingFloatMinor} currency={currency} locale={locale} />
          </Fact>
          <Muted>{t('pos.till.closeHint')}</Muted>
          <TextField
            label={t('pos.till.closingCount', { currency })}
            hint={t('pos.till.closingCountHint')}
            inputMode="decimal"
            value={props.closingCountText}
            disabled={props.busy}
            error={props.closingCountInvalid ? t('pos.till.amountInvalid') : undefined}
            onChange={props.onClosingCount}
          />
          <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
          <Button fullWidth onClick={props.onBackToSelling}>
            {t('pos.till.backToSelling')}
          </Button>
          <Button variant="secondary" fullWidth disabled={props.busy} onClick={props.onAskClose}>
            {t('pos.till.close')}
          </Button>
          <ConfirmationDialog
            open={props.confirmingClose}
            title={t('pos.till.close')}
            message={t('pos.till.closeHint')}
            confirmLabel={t('pos.till.close')}
            cancelLabel={t('common.cancel')}
            danger
            loading={props.busy}
            onConfirm={props.onClose}
            onCancel={props.onCancelClose}
          />
        </Stack>
      ) : (
        <Stack gap={4}>
          <Notice tone={props.justClosed ? 'success' : 'info'}>{props.justClosed ? t('pos.till.closed') : t('pos.till.none')}</Notice>
          <Muted>{t('pos.till.openHint')}</Muted>
          <Select label={t('pos.till.where')} value={props.branchId} options={options} disabled={props.busy} onChange={props.onBranch} />
          <TextField
            label={t('pos.till.openingFloat', { currency })}
            hint={t('pos.till.openingFloatHint')}
            inputMode="decimal"
            value={props.openingFloatText}
            disabled={props.busy}
            error={props.openingFloatInvalid ? t('pos.till.amountInvalid') : undefined}
            onChange={props.onOpeningFloat}
          />
          <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
          <Button fullWidth loading={props.busy} disabled={props.branchId === ''} onClick={props.onOpen}>
            {t('pos.till.open')}
          </Button>
        </Stack>
      )}
    </div>
  );
}
