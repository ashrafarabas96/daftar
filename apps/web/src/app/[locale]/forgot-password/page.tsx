'use client';
import { use, useState } from 'react';
import { Button, Card, TextField, spacing, typography, colors } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { requestPasswordReset } from '@/lib/merchant-api';

export default function ForgotPasswordPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    // Generic response by design — the API never reveals account existence.
    await requestPasswordReset(email).catch(() => undefined);
    setBusy(false);
    setSent(true);
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: spacing[4] }}>
      <Card style={{ width: '100%', maxWidth: '24rem' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{t('auth.resetTitle')}</h1>
        {sent ? (
          <p style={{ color: colors.neutral[700] }}>{t('auth.resetSent')}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}
          >
            <TextField label={t('auth.email')} type="email" required value={email} onChange={setEmail} autoComplete="email" />
            <Button type="submit" loading={busy} fullWidth>
              {t('auth.sendReset')}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
