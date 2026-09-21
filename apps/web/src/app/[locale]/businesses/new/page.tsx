'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CountryDto, CurrencyDto } from '@daftar/shared-contracts';
import { Button, Combobox, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession, setCurrentBusinessId } from '@/lib/client';
import { createBusinessInTenant, getCountries, getCurrencies, getCurrentBusiness } from '@/lib/merchant-api';
import { PageShell } from '../../AppHeader';

/**
 * CREATE BUSINESS (Directive §62): an additional business in the CURRENT
 * tenant — the target tenant is explicit (taken from the current business),
 * the server verifies the caller is that tenant's active owner.
 */
export default function NewBusinessPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('');
  const [storeSlug, setStoreSlug] = useState('');
  const [ref, setRef] = useState<{ countries: CountryDto[]; currencies: CurrencyDto[] }>({ countries: [], currencies: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      const [biz, countries, currencies] = await Promise.all([getCurrentBusiness(), getCountries(), getCurrencies()]);
      setTenantId(biz.tenantId);
      setRef({ countries: countries.items, currencies: currencies.items });
    })();
  }, [locale, router]);

  async function submit() {
    if (!tenantId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createBusinessInTenant(tenantId, { businessName, countryCode, baseCurrency, storeSlug, preferredLocale: locale });
      setCurrentBusinessId(res.businessId);
      router.push(`/${locale}/dashboard`);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? t('business.ownerOnly')
          : e instanceof ApiError && e.code === 'SLUG_TAKEN'
            ? t('onboarding.slugTaken')
            : t('error.generic'),
      );
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="settings">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('business.createTitle')}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: spacing[4], maxWidth: '28rem' }}
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
          options={ref.currencies.map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }))}
        />
        <TextField label={t('onboarding.slug')} required value={storeSlug} onChange={(v) => setStoreSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
        {error ? (
          <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" loading={busy} disabled={!tenantId || storeSlug.length < 2}>
            {t('business.create')}
          </Button>
        </div>
      </form>
    </PageShell>
  );
}
