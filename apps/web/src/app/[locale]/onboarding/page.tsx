'use client';
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Combobox, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { refreshSession, setCurrentBusinessId } from '@/lib/client';
import { checkSlugAvailability, completeOnboarding, getCountries, getCurrencies } from '@/lib/merchant-api';
import type { CountryDto, CurrencyDto } from '@daftar/shared-contracts';

interface RefData {
  countries: CountryDto[];
  currencies: CurrencyDto[];
}

export default function OnboardingPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [businessName, setBusinessName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('');
  const [storeSlug, setStoreSlug] = useState('');
  const [slugState, setSlugState] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [ref, setRef] = useState<RefData>({ countries: [], currencies: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      const [countries, currencies] = await Promise.all([getCountries(), getCurrencies()]);
      setRef({ countries: countries.items, currencies: currencies.items });
    })();
  }, [locale, router]);

  useEffect(() => {
    if (storeSlug.length < 3) {
      setSlugState('idle');
      return;
    }
    setSlugState('checking');
    if (slugTimer.current) clearTimeout(slugTimer.current);
    slugTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await checkSlugAvailability(storeSlug);
          setSlugState(res.available ? 'available' : 'taken');
        } catch {
          setSlugState('idle');
        }
      })();
    }, 350);
  }, [storeSlug]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await completeOnboarding({ businessName, countryCode, baseCurrency, storeSlug, preferredLocale: locale });
      setCurrentBusinessId(res.businessId);
      router.push(`/${locale}/dashboard`);
    } catch {
      setError(t('error.generic'));
      setBusy(false);
    }
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: spacing[4] }}>
      <Card style={{ width: '100%', maxWidth: '28rem' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>{t('onboarding.title')}</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}
        >
          <TextField label={t('onboarding.businessName')} required value={businessName} onChange={setBusinessName} />
          <Combobox
            label={t('onboarding.country')}
            required
            value={countryCode}
            onSelect={setCountryCode}
            options={ref.countries.map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))}
          />
          <Combobox
            label={t('onboarding.currency')}
            required
            value={baseCurrency}
            onSelect={setBaseCurrency}
            options={ref.currencies.map((c) => ({ value: c.code, label: c.code }))}
          />
          <TextField
            label={t('onboarding.slug')}
            required
            value={storeSlug}
            onChange={(v) => setStoreSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            hint={
              slugState === 'checking'
                ? t('onboarding.slugChecking')
                : slugState === 'available'
                  ? t('onboarding.slugAvailable')
                  : slugState === 'taken'
                    ? t('onboarding.slugTaken')
                    : undefined
            }
            error={slugState === 'taken' ? t('onboarding.slugTaken') : undefined}
          />
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}
          <Button type="submit" loading={busy} fullWidth disabled={slugState === 'taken'}>
            {t('onboarding.submit')}
          </Button>
        </form>
      </Card>
    </main>
  );
}
