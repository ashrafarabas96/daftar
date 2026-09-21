'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Select, TextField, spacing, typography, colors } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { refreshSession } from '@/lib/client';
import { getCurrentBusiness, updateCurrentBusiness } from '@/lib/merchant-api';
import type { BusinessSettingsDto } from '@daftar/shared-contracts';
import { PageShell } from '../AppHeader';

type Business = BusinessSettingsDto;

export default function SettingsPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [business, setBusiness] = useState<Business | null>(null);
  const [name, setName] = useState('');
  const [defaultLocale, setDefaultLocale] = useState('ar');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

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
    })();
  }, [locale]);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      await updateCurrentBusiness({ name, defaultLocale: defaultLocale as Business['defaultLocale'] });
      setSaved(true);
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
          <Select
            label={t('settings.defaultLocale')}
            value={defaultLocale}
            onChange={setDefaultLocale}
            options={[
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
              { value: 'tr', label: 'Türkçe' },
            ]}
          />
          <TextField label={t('settings.baseCurrency')} value={business.baseCurrency} disabled hint={t('settings.currencyLocked')} onChange={() => undefined} />
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
        </form>
      ) : (
        <p>{t('common.loading')}</p>
      )}
    </PageShell>
  );
}
