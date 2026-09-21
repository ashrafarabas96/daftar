'use client';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, PasswordField, TextField, spacing, typography, colors } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { setAccessToken } from '@/lib/client';

export default function LoginPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 429 ? t('error.rateLimited') : t('auth.invalidCredentials'));
      return;
    }
    const data = (await res.json()) as { accessToken: string };
    setAccessToken(data.accessToken);
    router.push(`/${locale}/dashboard`);
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: spacing[4] }}>
      <Card style={{ width: '100%', maxWidth: '24rem' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{t('auth.loginTitle')}</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}
        >
          <TextField label={t('auth.email')} type="email" required value={email} onChange={setEmail} autoComplete="email" />
          <PasswordField label={t('auth.password')} required value={password} onChange={setPassword} />
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}
          <Button type="submit" loading={busy} fullWidth>
            {t('auth.login')}
          </Button>
        </form>
        <p style={{ fontSize: typography.size.sm }}>
          <a href={`/${locale}/forgot-password`}>{t('auth.forgot')}</a>
        </p>
        <p style={{ fontSize: typography.size.sm }}>
          <a href={`/${locale}/register`}>{t('auth.needAccount')}</a>
        </p>
      </Card>
    </main>
  );
}
