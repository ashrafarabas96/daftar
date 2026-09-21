'use client';
import { Suspense, use, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, PasswordField, spacing, typography, colors } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { completePasswordReset } from '@/lib/merchant-api';

function ResetForm({ locale }: { locale: Locale }) {
  const t = makeT(locale);
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await completePasswordReset(token, password);
    } catch {
      setBusy(false);
      setError(t('error.generic'));
      return;
    }
    setBusy(false);
    router.push(`/${locale}/login`);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}
    >
      <PasswordField label={t('auth.newPassword')} required value={password} onChange={setPassword} autoComplete="new-password" />
      {error ? (
        <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={busy} fullWidth disabled={!token}>
        {t('auth.reset')}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: spacing[4] }}>
      <Card style={{ width: '100%', maxWidth: '24rem' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{t('auth.resetTitle')}</h1>
        <Suspense>
          <ResetForm locale={locale} />
        </Suspense>
      </Card>
    </main>
  );
}
