'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CategoryDto, LocaleCode, ProductListItemDto } from '@daftar/shared-contracts';
import { formatMinor, minorUnitsOf, parseMajorToMinor } from '@daftar/shared-contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  PlanLimitState,
  SearchField,
  Select,
  Table,
  Tabs,
  TextField,
  colors,
  spacing,
  typography,
} from '@daftar/design-system';
import { makeT, type Locale } from '@/lib/i18n';
import { ApiError, refreshSession } from '@/lib/client';
import { createCategory, createProduct, getCurrentBusiness, listCategories, listProducts } from '@/lib/merchant-api';
import { PageShell } from '../AppHeader';

interface VariantDraft {
  attribute: string;
  value: string;
  sku: string;
  price: string;
}

/** Catalog (Directive §62): products (create with variants), categories, search, edit link, plan-limit state. */
export default function CatalogPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const [tab, setTab] = useState('products');
  const [products, setProducts] = useState<ProductListItemDto[]>([]);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<'product' | 'category' | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [sku, setSku] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [catNames, setCatNames] = useState<Partial<Record<LocaleCode, string>>>({});
  const [priceError, setPriceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);

  async function load(q = '') {
    const [p, c] = await Promise.all([listProducts(q || undefined), listCategories()]);
    setProducts(p.items);
    setCategories(c.items);
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

  function reset() {
    setName('');
    setPrice('');
    setSku('');
    setCategoryId('');
    setVariants([]);
    setCatNames({});
    setPriceError(null);
    setError(null);
  }

  /** Product creation law: Name + Price + Save. Everything else is progressive disclosure. */
  async function saveProduct() {
    if (!baseCurrency) return;
    const units = minorUnitsOf(baseCurrency);
    let minor: string;
    try {
      // §38: exact decimal parser with the currency's real minor units (JOD=3…).
      minor = parseMajorToMinor(price, units);
    } catch {
      setPriceError(t('catalog.priceInvalid'));
      return;
    }
    let variantPayload: { attributes: Record<string, string>; sku?: string; priceMinor?: string }[];
    try {
      variantPayload = variants.map((v) => ({
        attributes: v.attribute.trim() ? { [v.attribute.trim()]: v.value.trim() } : {},
        ...(v.sku.trim() ? { sku: v.sku.trim() } : {}),
        ...(v.price.trim() ? { priceMinor: parseMajorToMinor(v.price, units) } : {}),
      }));
    } catch {
      setPriceError(t('catalog.priceInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setLimit(false);
    try {
      await createProduct({
        translations: { [locale]: name },
        basePriceMinor: minor,
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(variantPayload.length > 0 ? { variants: variantPayload } : {}),
      });
      setOpen(null);
      reset();
      setToast(t('catalog.created'));
      await load(search);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PLAN_LIMIT_EXCEEDED') {
        setLimit(true);
        setOpen(null);
      } else if (e instanceof ApiError && e.status === 409) setError(t('catalog.duplicateIdentifier'));
      else setError(e instanceof ApiError && e.status === 403 ? t('common.noPermission') : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function saveCategory() {
    const translations = Object.fromEntries(Object.entries(catNames).filter(([, v]) => v && v.trim())) as Partial<Record<LocaleCode, string>>;
    if (Object.keys(translations).length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await createCategory(translations);
      setOpen(null);
      reset();
      await load(search);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('common.noPermission') : t('error.generic'));
    } finally {
      setBusy(false);
    }
  }

  const catLabel = (c: CategoryDto) => c.translations[locale] ?? Object.values(c.translations)[0] ?? c.id;

  return (
    <PageShell locale={locale} active="catalog">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: spacing[4], flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, margin: 0 }}>{t('catalog.title')}</h1>
        <Button onClick={() => setOpen(tab === 'products' ? 'product' : 'category')}>
          {tab === 'products' ? t('catalog.newProduct') : t('catalog.newCategory')}
        </Button>
      </div>
      <Tabs
        tabs={[
          { key: 'products', label: t('catalog.products') },
          { key: 'categories', label: t('catalog.categories') },
        ]}
        active={tab}
        onChange={setTab}
      />
      {limit ? <PlanLimitState title={t('catalog.limitReached')} upgradeLabel={t('nav.plan')} onUpgrade={() => router.push(`/${locale}/plan`)} /> : null}
      {tab === 'products' ? (
        <>
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
            <EmptyState title={t('catalog.empty')} actionLabel={t('catalog.newProduct')} onAction={() => setOpen('product')} />
          ) : (
            <Table
              rows={products}
              columns={[
                { key: 'name', header: t('catalog.productName'), render: (p) => <a href={`/${locale}/catalog/${p.id}`}>{p.name}</a> },
                { key: 'sku', header: t('catalog.sku'), render: (p) => p.sku ?? '—' },
                // §39: formatted major value via Intl/CLDR — never the raw minor integer.
                { key: 'price', header: t('catalog.price'), align: 'end', render: (p) => formatMinor(p.basePriceMinor, p.priceCurrency, locale) },
                {
                  key: 'status',
                  header: t('team.status'),
                  render: (p) =>
                    p.status === 'archived' ? <Badge tone="neutral">{t('catalog.archived')}</Badge> : <Badge tone="success">{t('team.active')}</Badge>,
                },
                {
                  key: 'edit',
                  header: '',
                  align: 'end',
                  render: (p) => (
                    <Button size="sm" variant="ghost" onClick={() => router.push(`/${locale}/catalog/${p.id}`)}>
                      {t('catalog.edit')}
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </>
      ) : categories.length === 0 ? (
        <EmptyState title={t('catalog.noCategories')} actionLabel={t('catalog.newCategory')} onAction={() => setOpen('category')} />
      ) : (
        <div style={{ marginTop: spacing[4] }}>
          <Table
            rows={categories}
            columns={[
              { key: 'name', header: t('catalog.categoryName'), render: (c) => catLabel(c) },
              {
                key: 'parent',
                header: t('catalog.parent'),
                render: (c) => (c.parentId ? (categories.find((x) => x.id === c.parentId)?.translations[locale] ?? '—') : '—'),
              },
              { key: 'langs', header: t('catalog.translations'), render: (c) => Object.keys(c.translations).join(', ') },
            ]}
          />
        </div>
      )}
      <Dialog
        open={open === 'product'}
        title={t('catalog.newProduct')}
        onClose={() => setOpen(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!name.trim() || !price.trim()} onClick={() => void saveProduct()}>
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
          <TextField label={t('catalog.sku')} value={sku} onChange={setSku} />
          <Select
            label={t('catalog.category')}
            value={categoryId}
            onChange={setCategoryId}
            options={[{ value: '', label: '—' }, ...categories.map((c) => ({ value: c.id, label: catLabel(c) }))]}
          />
          <div>
            <p style={{ margin: `0 0 ${spacing[2]}`, fontFamily: typography.fontFamily.base, fontSize: typography.size.sm, color: colors.neutral[600] }}>
              {t('catalog.variants')}
            </p>
            {variants.map((v, i) => (
              <div
                key={i}
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: spacing[2], alignItems: 'end', marginBottom: spacing[2] }}
              >
                <TextField
                  label={t('catalog.attribute')}
                  value={v.attribute}
                  onChange={(x) => setVariants(variants.map((o, j) => (j === i ? { ...o, attribute: x } : o)))}
                />
                <TextField
                  label={t('catalog.value')}
                  value={v.value}
                  onChange={(x) => setVariants(variants.map((o, j) => (j === i ? { ...o, value: x } : o)))}
                />
                <TextField label={t('catalog.sku')} value={v.sku} onChange={(x) => setVariants(variants.map((o, j) => (j === i ? { ...o, sku: x } : o)))} />
                <TextField
                  label={t('catalog.price')}
                  value={v.price}
                  onChange={(x) => setVariants(variants.map((o, j) => (j === i ? { ...o, price: x } : o)))}
                  inputMode="decimal"
                />
                <Button size="sm" variant="ghost" onClick={() => setVariants(variants.filter((_, j) => j !== i))}>
                  {t('common.delete')}
                </Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setVariants([...variants, { attribute: '', value: '', sku: '', price: '' }])}>
              {t('catalog.addVariant')}
            </Button>
          </div>
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
      <Dialog
        open={open === 'category'}
        title={t('catalog.newCategory')}
        onClose={() => setOpen(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t('common.cancel')}
            </Button>
            <Button loading={busy} disabled={!Object.values(catNames).some((v) => v && v.trim())} onClick={() => void saveCategory()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}>
          {(['ar', 'en', 'tr'] as LocaleCode[]).map((l) => (
            <TextField
              key={l}
              label={`${t('catalog.categoryName')} (${t(`locale.${l}`)})`}
              value={catNames[l] ?? ''}
              onChange={(v) => setCatNames({ ...catNames, [l]: v })}
            />
          ))}
          {error ? (
            <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>
              {error}
            </p>
          ) : null}
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
