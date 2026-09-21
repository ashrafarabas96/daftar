'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BusinessSettingsDto, LocaleCode } from '@daftar/shared-contracts';
import { Button, Checkbox, Combobox, Select, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession } from '@/lib/client';
import { getCurrentBusiness, updateCurrentBusiness } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

const LOCALE_OPTIONS: { value: LocaleCode; label: string }[] = [
  { value: 'ar', label: 'العربية' },
  { value: 'en', label: 'English' },
  { value: 'tr', label: 'Türkçe' },
];

/** Business settings (Directive §62): name, default + enabled + storefront locales, IANA timezone; base currency is server-locked. */
export default function SettingsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [business, setBusiness] = useState<BusinessSettingsDto | null>(null);
  const [name, setName] = useState('');
  const [defaultLocale, setDefaultLocale] = useState<LocaleCode>('ar');
  const [storefrontLocale, setStorefrontLocale] = useState<LocaleCode>('ar');
  const [enabled, setEnabled] = useState<Set<LocaleCode>>(new Set(['ar']));
  const [timezone, setTimezone] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timezones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      const b = await getCurrentBusiness();
      setBusiness(b);
      setName(b.name);
      setDefaultLocale(b.defaultLocale);
      setStorefrontLocale(b.storefrontLocale);
      setEnabled(new Set(b.enabledLocales));
      setTimezone(b.timezone);
    })();
  }, [locale, router]);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const enabledLocales = [...new Set([...enabled, defaultLocale])];
      const updated = await updateCurrentBusiness({ name, defaultLocale, enabledLocales, storefrontLocale, timezone });
      setBusiness(updated);
      setEnabled(new Set(updated.enabledLocales));
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? t('settings.invalidTimezone')
          : e instanceof ApiError && e.status === 403
            ? t('common.noPermission')
            : t('error.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="settings">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('settings.title')}</h1>
      {business ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: spacing[4], maxWidth: '28rem' }}
        >
          <TextField label={t('settings.businessName')} required value={name} onChange={setName} />
          <Select label={t('settings.defaultLocale')} value={defaultLocale} onChange={(v) => setDefaultLocale(v as LocaleCode)} options={LOCALE_OPTIONS} />
          <div>
            <p style={{ margin: `0 0 ${spacing[1]}`, fontFamily: typography.fontFamily.base, fontSize: typography.size.sm, color: colors.neutral[600] }}>
              {t('settings.enabledLocales')}
            </p>
            {LOCALE_OPTIONS.map((o) => (
              <Checkbox
                key={o.value}
                label={o.label}
                checked={enabled.has(o.value) || o.value === defaultLocale}
                disabled={o.value === defaultLocale}
                onChange={(v) => {
                  const next = new Set(enabled);
                  if (v) next.add(o.value);
                  else next.delete(o.value);
                  setEnabled(next);
                }}
              />
            ))}
          </div>
          <Select
            label={t('settings.storefrontLocale')}
            value={storefrontLocale}
            onChange={(v) => setStorefrontLocale(v as LocaleCode)}
            options={LOCALE_OPTIONS}
          />
          <Combobox label={t('settings.timezone')} value={timezone} onSelect={setTimezone} options={timezones.map((z) => ({ value: z, label: z }))} />
          <TextField
            label={t('settings.baseCurrency')}
            value={business.baseCurrency}
            disabled
            hint={business.baseCurrencyLocked ? t('settings.currencyLocked') : t('settings.currencyLockedSoon')}
            onChange={() => undefined}
          />
          <div>
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </div>
          {saved ? (
            <p role="status" style={{ color: colors.semantic.success }}>
              {t('settings.saved')}
            </p>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger }}>
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p>{t('common.loading')}</p>
      )}
    </PageShell>
  );
}
