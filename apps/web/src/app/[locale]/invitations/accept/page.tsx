'use client';
import { Suspense, use, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, PasswordField, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession, setAccessToken, setCurrentBusinessId } from '@/lib/client';
import { acceptInvitation, acceptInvitationRegister } from '@/lib/merchant-api';

/**
 * Invitation acceptance (Directive §62 "Invitations"): a signed-in user
 * accepts with the token; a new user registers + joins in one step.
 */
function AcceptInvitationForm({ locale }: { locale: Locale }) {
  const t = makeT(locale);
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get('token') ?? '';
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSession().then(setSignedIn);
  }, []);

  function fail(e: unknown) {
    if (e instanceof ApiError && e.code === 'INVITATION_EXPIRED') setError(t('invite.expired'));
    else if (e instanceof ApiError && e.status === 404) setError(t('invite.notFound'));
    else if (e instanceof ApiError && e.status === 403) setError(t('invite.wrongEmail'));
    else if (e instanceof ApiError && e.code === 'ALREADY_MEMBER') setError(t('invite.alreadyMember'));
    else setError(t('error.generic'));
  }

  async function acceptAsMe() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptInvitation(token);
      setCurrentBusinessId(res.businessId);
      router.push(`/${locale}/dashboard`);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }

  async function registerAndAccept() {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptInvitationRegister({ token, email, password, displayName });
      setCurrentBusinessId(res.businessId);
      // Establish a session for the new identity through the BFF login.
      const login = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (login.ok) setAccessToken(((await login.json()) as { accessToken: string }).accessToken);
      router.push(login.ok ? `/${locale}/dashboard` : `/${locale}/login`);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: spacing[4] }}>
      <Card style={{ width: '100%', maxWidth: '26rem' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{t('invite.title')}</h1>
        {!token ? (
          <p role="alert" style={{ color: colors.semantic.danger }}>
            {t('invite.notFound')}
          </p>
        ) : signedIn === null ? (
          <p>{t('common.loading')}</p>
        ) : signedIn ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
            <p style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('invite.acceptAsCurrent')}</p>
            <Button loading={busy} fullWidth onClick={() => void acceptAsMe()}>
              {t('invite.accept')}
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void registerAndAccept();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}
          >
            <p style={{ fontFamily: typography.fontFamily.base, margin: 0, fontSize: typography.size.sm }}>{t('invite.registerHint')}</p>
            <TextField label={t('auth.displayName')} required value={displayName} onChange={setDisplayName} autoComplete="name" />
            <TextField label={t('auth.email')} type="email" required value={email} onChange={setEmail} autoComplete="email" hint={t('invite.emailMustMatch')} />
            <PasswordField label={t('auth.password')} required value={password} onChange={setPassword} autoComplete="new-password" />
            <Button type="submit" loading={busy} fullWidth>
              {t('invite.registerAndJoin')}
            </Button>
            <p style={{ fontSize: typography.size.sm, margin: 0 }}>
              <a href={`/${locale}/login`}>{t('auth.haveAccount')}</a>
            </p>
          </form>
        )}
        {error ? (
          <p role="alert" style={{ color: colors.semantic.danger }}>
            {error}
          </p>
        ) : null}
      </Card>
    </main>
  );
}

/** useSearchParams() needs a Suspense boundary for static prerendering (Next 15). */
export default function AcceptInvitationPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  return (
    <Suspense fallback={null}>
      <AcceptInvitationForm locale={locale} />
    </Suspense>
  );
}
