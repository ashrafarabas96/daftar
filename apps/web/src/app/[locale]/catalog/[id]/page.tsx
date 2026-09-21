'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CategoryDto, LocaleCode, ProductDto } from '@daftar/shared-contracts';
import { formatMinor, minorUnitsOf, parseMajorToMinor } from '@daftar/shared-contracts';
import { Badge, Button, Select, Table, TextField, colors, spacing, typography } from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession } from '@/lib/client';
import { archiveProduct, attachMedia, getMediaAccessUrl, getProduct, listCategories, updateProduct, uploadMedia } from '@/lib/merchant-api';
import { PageShell } from '../../AppHeader';

const LOCALES: LocaleCode[] = ['ar', 'en', 'tr'];

/**
 * Product edit (Directive §62): translations (ar/en/tr), price in the business
 * base currency (exact minor units), SKU/barcode/unit, category, variants,
 * media (upload → attach → short-TTL signed preview), archive. Optimistic
 * concurrency: the edit carries the version it was based on.
 */
export default function ProductEditPage({ params }: { params: Promise<{ locale: Locale; id: string }> }) {
  const { locale, id } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [product, setProduct] = useState<ProductDto | null>(null);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [translations, setTranslations] = useState<Partial<Record<LocaleCode, string>>>({});
  const [price, setPrice] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [unit, setUnit] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [p, c] = await Promise.all([getProduct(id), listCategories()]);
    setProduct(p);
    setCategories(c.items);
    setTranslations(p.translations);
    setSku(p.sku ?? '');
    setBarcode(p.barcode ?? '');
    setUnit(p.unit ?? '');
    setCategoryId(p.categoryId ?? '');
    const units = minorUnitsOf(p.priceCurrency);
    const minor = BigInt(p.basePriceMinor);
    const scale = 10n ** BigInt(units);
    setPrice(units === 0 ? minor.toString() : `${minor / scale}.${(minor % scale).toString().padStart(units, '0')}`);
    // Private storage: previews come from short-TTL signed URLs, one per media item.
    const urls: Record<string, string> = {};
    for (const m of p.media) {
      try {
        urls[m.id] = (await getMediaAccessUrl(m.id, 'w256')).url;
      } catch {
        try {
          urls[m.id] = (await getMediaAccessUrl(m.id)).url;
        } catch {
          /* preview unavailable — the row still renders */
        }
      }
    }
    setPreviews(urls);
  }

  useEffect(() => {
    void (async () => {
      if (!(await refreshSession())) {
        router.push(`/${locale}/login`);
        return;
      }
      try {
        await load();
      } catch {
        setError(t('error.generic'));
      }
    })();
  }, [locale, router, id]);

  async function save() {
    if (!product) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    let basePriceMinor: string;
    try {
      basePriceMinor = parseMajorToMinor(price, minorUnitsOf(product.priceCurrency));
    } catch {
      setError(t('catalog.priceInvalid'));
      setBusy(false);
      return;
    }
    const cleaned = Object.fromEntries(Object.entries(translations).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)) as Partial<
      Record<LocaleCode, string>
    >;
    try {
      await updateProduct(product.id, {
        translations: cleaned,
        basePriceMinor,
        sku: sku.trim() || null,
        barcode: barcode.trim() || null,
        unit: unit.trim() || null,
        categoryId: categoryId || null,
        version: product.version,
      });
      setMessage(t('catalog.saved'));
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? t('catalog.conflict')
          : e instanceof ApiError && e.status === 403
            ? t('common.noPermission')
            : t('error.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | null) {
    if (!file || !product) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadMedia(file);
      await attachMedia(product.id, uploaded.id);
      setMessage(t('catalog.mediaUploaded'));
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 413
          ? t('catalog.mediaTooLarge')
          : e instanceof ApiError && e.status === 415
            ? t('catalog.mediaInvalid')
            : t('error.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!product) return;
    setBusy(true);
    try {
      await archiveProduct(product.id);
      router.push(`/${locale}/catalog`);
    } catch {
      setError(t('error.generic'));
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="catalog">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: spacing[4], flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{product ? product.name : t('catalog.editProduct')}</h1>
        {product ? (
          <span style={{ display: 'inline-flex', gap: spacing[2] }}>
            <Badge tone="neutral">v{product.version}</Badge>
            {product.status === 'archived' ? <Badge tone="neutral">{t('catalog.archived')}</Badge> : <Badge tone="success">{t('team.active')}</Badge>}
          </span>
        ) : null}
      </div>
      {product ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: spacing[4], maxWidth: '36rem' }}
        >
          <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg, margin: `${spacing[2]} 0 0` }}>{t('catalog.translations')}</h2>
          {LOCALES.map((l) => (
            <TextField
              key={l}
              label={`${t('catalog.productName')} (${t(`locale.${l}`)})`}
              value={translations[l] ?? ''}
              onChange={(v) => setTranslations({ ...translations, [l]: v })}
            />
          ))}
          <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg, margin: `${spacing[2]} 0 0` }}>{t('catalog.details')}</h2>
          <TextField
            label={`${t('catalog.price')} (${product.priceCurrency})`}
            required
            value={price}
            onChange={setPrice}
            inputMode="decimal"
            hint={formatMinor(product.basePriceMinor, product.priceCurrency, locale)}
          />
          <TextField label={t('catalog.sku')} value={sku} onChange={setSku} />
          <TextField label={t('catalog.barcode')} value={barcode} onChange={setBarcode} />
          <TextField label={t('catalog.unit')} value={unit} onChange={setUnit} />
          <Select
            label={t('catalog.category')}
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: '', label: '—' },
              ...categories.map((c) => ({ value: c.id, label: c.translations[locale] ?? Object.values(c.translations)[0] ?? c.id })),
            ]}
          />
          <div style={{ display: 'flex', gap: spacing[2] }}>
            <Button type="submit" loading={busy} disabled={product.status === 'archived'}>
              {t('common.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push(`/${locale}/catalog`)}>
              {t('common.back')}
            </Button>
            {product.status !== 'archived' ? (
              <Button type="button" variant="danger" loading={busy} onClick={() => void archive()}>
                {t('common.archive')}
              </Button>
            ) : null}
          </div>
          {message ? (
            <p role="status" style={{ color: colors.semantic.success, margin: 0 }}>
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}

          <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg, margin: `${spacing[4]} 0 0` }}>{t('catalog.variants')}</h2>
          {product.variants.length === 0 ? (
            <p style={{ margin: 0, color: colors.neutral[500], fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
              {t('catalog.noVariants')}
            </p>
          ) : (
            <Table
              rows={product.variants}
              columns={[
                {
                  key: 'attrs',
                  header: t('catalog.attributes'),
                  render: (v) =>
                    Object.entries(v.attributes)
                      .map(([k, val]) => `${k}: ${val}`)
                      .join(', ') || '—',
                },
                { key: 'sku', header: t('catalog.sku'), render: (v) => v.sku ?? '—' },
                { key: 'barcode', header: t('catalog.barcode'), render: (v) => v.barcode ?? '—' },
                {
                  key: 'price',
                  header: t('catalog.price'),
                  align: 'end',
                  render: (v) => (v.priceMinor ? formatMinor(v.priceMinor, product.priceCurrency, locale) : t('catalog.inheritsPrice')),
                },
              ]}
            />
          )}

          <h2 style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.lg, margin: `${spacing[4]} 0 0` }}>{t('catalog.media')}</h2>
          <div style={{ display: 'flex', gap: spacing[3], flexWrap: 'wrap' }}>
            {product.media.map((m) => (
              <figure key={m.id} style={{ margin: 0, width: '7rem' }}>
                {previews[m.id] ? (
                  <img
                    src={previews[m.id]}
                    alt=""
                    style={{ width: '7rem', height: '7rem', objectFit: 'cover', borderRadius: '0.5rem', border: `1px solid ${colors.neutral[200]}` }}
                  />
                ) : (
                  <div style={{ width: '7rem', height: '7rem', borderRadius: '0.5rem', background: colors.neutral[100] }} />
                )}
              </figure>
            ))}
          </div>
          <label style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
            {t('catalog.addPhoto')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy || product.status === 'archived'}
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
              style={{ display: 'block', marginTop: spacing[2] }}
            />
          </label>
        </form>
      ) : (
        <p>{error ?? t('common.loading')}</p>
      )}
    </PageShell>
  );
}
