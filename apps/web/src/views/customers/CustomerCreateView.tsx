/**
 * "New customer" (P4-S1): a person or shop the merchant sells to, entered by
 * name, with a phone, an email and a note if the merchant has them.
 *
 * A pure view. It computes nothing: every value on the saved screen is one the
 * server sent back, shown verbatim; every value on the form is one the
 * merchant is typing.
 *
 * A refusal is shown beside the form, which keeps every value typed (the page
 * sets the refusal and touches nothing else). A replay of a customer already
 * saved is a success, said as such. When a customer may be saved but could not
 * be read back, there is no form and no new form, only "read again": entering
 * it a second time would be a second customer.
 */
import { Button, TextField, Textarea } from '@daftar/design-system';
import type { CustomerCommandResultDto, CustomerDto } from '@daftar/shared-contracts';
import { Ltr, type ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { Fact, Notice, Stack, Text, Title } from '../common/primitives';
import type { CreateField, CreateFormModel } from './customer-create';

export interface CustomerCreateViewProps {
  form: CreateFormModel;
  busy: boolean;
  errorKey: string | null;
  result: CustomerCommandResultDto | null;
  /** A customer already stored under this form's id, as the server read it back (`customer-create-flow.ts`). */
  stored: CustomerDto | null;
  /** This form's customer may be stored but could not be read: no form and no new form, only "read again". */
  storedUnread: boolean;
  on: {
    onField: (field: CreateField, value: string) => void;
    onSubmit: () => void;
    onRereadStored: () => void;
    /** A new form with a new id. Offered only beside a saved or an already-stored customer. */
    onStartOver: () => void;
  };
}

export function CustomerCreateView(props: CustomerCreateViewProps & ViewBaseProps) {
  const { t, locale } = props;
  if (props.result) return <Saved {...props} customer={props.result} replayed={props.result.replayed} />;
  if (props.stored) return <Saved {...props} customer={props.stored} replayed={false} alreadyRecorded />;
  return (
    <Stack>
      <Title>{t('customers.create.title')}</Title>
      {props.storedUnread ? null : <CustomerForm {...props} />}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.storedUnread ? (
        <Button fullWidth loading={props.busy} disabled={props.busy} onClick={props.on.onRereadStored}>
          {t('customers.create.readAgain')}
        </Button>
      ) : null}
    </Stack>
  );
}

function CustomerForm(props: CustomerCreateViewProps & ViewBaseProps) {
  const { t, form, on } = props;
  return (
    <Stack>
      <TextField
        label={t('customers.create.name')}
        value={form.name}
        autoComplete="off"
        error={form.errors.name ? t('customers.create.nameRequired') : undefined}
        onChange={(v) => on.onField('name', v)}
      />
      <TextField
        label={`${t('customers.create.phone')} (${t('common.optional')})`}
        type="tel"
        inputMode="tel"
        dir="ltr"
        value={form.phone}
        autoComplete="off"
        error={form.errors.phone ? t('customers.create.phoneInvalid') : undefined}
        onChange={(v) => on.onField('phone', v)}
      />
      <TextField
        label={`${t('customers.create.email')} (${t('common.optional')})`}
        type="email"
        inputMode="email"
        dir="ltr"
        value={form.email}
        autoComplete="off"
        error={form.errors.email ? t('customers.create.emailInvalid') : undefined}
        onChange={(v) => on.onField('email', v)}
      />
      <Textarea
        label={`${t('customers.create.notes')} (${t('common.optional')})`}
        value={form.notes}
        error={form.errors.notes ? t('customers.create.notesInvalid') : undefined}
        onChange={(v) => on.onField('notes', v)}
      />
      <Button fullWidth loading={props.busy} disabled={props.busy} onClick={on.onSubmit}>
        {t('customers.create.submit')}
      </Button>
    </Stack>
  );
}

/**
 * A customer the server has: just saved (or replayed), or already stored under this form's id. Every value
 * is the server's. An already-stored customer says so first, so it is not entered a second time.
 */
function Saved(props: CustomerCreateViewProps & ViewBaseProps & { customer: CustomerDto; replayed: boolean; alreadyRecorded?: boolean }) {
  const { t, customer } = props;
  return (
    <Stack>
      <Title>{t('customers.create.title')}</Title>
      <Notice tone="success">
        <Stack gap={2}>
          <Text strong>{props.alreadyRecorded ? t('customers.create.alreadyRecorded') : t('customers.create.done')}</Text>
          {props.replayed ? <Text>{t('customers.create.alreadySaved')}</Text> : null}
          <Fact label={t('customers.create.name')}>
            <bdi>{customer.name}</bdi>
          </Fact>
          {customer.phone !== null ? (
            <Fact label={t('customers.create.phone')}>
              <Ltr>{customer.phone}</Ltr>
            </Fact>
          ) : null}
          {customer.email !== null ? (
            <Fact label={t('customers.create.email')}>
              <Ltr>{customer.email}</Ltr>
            </Fact>
          ) : null}
          {customer.notes !== null ? (
            <Fact label={t('customers.create.notes')}>
              <bdi>{customer.notes}</bdi>
            </Fact>
          ) : null}
        </Stack>
      </Notice>
      <Button fullWidth onClick={props.on.onStartOver}>
        {t('customers.create.another')}
      </Button>
    </Stack>
  );
}
