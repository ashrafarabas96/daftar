'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProductListItemDto } from '@daftar/shared-contracts';
import { formatMinor, minorUnitsOf, parseMajorToMinor } from '@daftar/shared-contracts';
import { Badge, Button, Dialog, EmptyState, SearchField, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { refreshSession } from '@/lib/client';
import { createProduct, getCurrentBusiness, listProducts } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

export default function CatalogPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [products, setProducts] = useState<ProductListItemDto[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [priceError, setPriceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function load(q = '') {
    const res = await listProducts(q || undefined);
    setProducts(res.items);
  }

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      // §36: money context comes from the SERVER — the business base
      // currency, never a client hardcode.
      const biz = await getCurrentBusiness();
      setBaseCurrency(biz.baseCurrency);
      await load();
    })();
  }, [locale, router]);

  /** Product creation law: Name + Price + Save. Everything else is progressive disclosure. */
  async function save() {
    if (!baseCurrency) return;
    let minor: string;
    try {
      // §38: exact decimal parser with the currency's real minor units (JOD=3…).
      minor = parseMajorToMinor(price, minorUnitsOf(baseCurrency));
    } catch {
      setPriceError(t('catalog.price'));
      return;
    }
    setBusy(true);
    try {
      await createProduct({ name, basePriceMinor: minor, locale });
      setOpen(false);
      setName('');
      setPrice('');
      setToast(t('catalog.created'));
      await load(search);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="catalog">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: spacing[4], flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('catalog.title')}</h1>
        <Button onClick={() => setOpen(true)}>{t('catalog.newProduct')}</Button>
      </div>
      <div style={{ margin: `${spacing[4]} 0`, maxWidth: '24rem' }}>
        <SearchField
          label={t('common.search')}
          placeholder={t('catalog.searchPlaceholder')}
          value={search}
          onChange={(v) => {
            setSearch(v);
            void load(v);
          }}
        />
      </div>
      {products.length === 0 ? (
        <EmptyState title={t('catalog.empty')} actionLabel={t('catalog.newProduct')} onAction={() => setOpen(true)} />
      ) : (
        <Table
          rows={products}
          columns={[
            { key: 'name', header: t('catalog.productName'), render: (p) => p.name },
            { key: 'sku', header: t('catalog.sku'), render: (p) => p.sku ?? '—' },
            // §39: formatted major value via Intl/CLDR — never the raw minor integer.
            { key: 'price', header: t('catalog.price'), align: 'end', render: (p) => formatMinor(p.basePriceMinor, p.priceCurrency, locale) },
            {
              key: 'status',
              header: t('team.status'),
              render: (p) =>
                p.status === 'archived' ? <Badge tone="neutral">{t('catalog.archived')}</Badge> : <Badge tone="success">{t('team.active')}</Badge>,
            },
          ]}
        />
      )}
      <Dialog
        open={open}
        title={t('catalog.newProduct')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!name.trim() || !price.trim()} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          <TextField label={t('catalog.productName')} required value={name} onChange={setName} autoFocus />
          <TextField
            label={`${t('catalog.price')}${baseCurrency ? ` (${baseCurrency})` : ''}`}
            required
            value={price}
            onChange={setPrice}
            error={priceError ?? undefined}
            inputMode="decimal"
          />
        </div>
      </Dialog>
      {toast ? (
        <p role="status" style={{ color: colors.semantic.success, fontFamily: typography.fontFamily.base }}>
          {toast}
        </p>
      ) : null}
    </PageShell>
  );
}
