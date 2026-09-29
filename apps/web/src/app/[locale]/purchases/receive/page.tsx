'use client';
/**
 * Receive Purchase (P3-S7 contract A-11, A-13, A-14; Annex R #6).
 *
 * The container: it loads the pickers, keeps the form, saves the draft
 * (`PUT /v1/purchases/:id`, revision retry kind) and receives it — or, with
 * "Paid now", receives and pays it in one command. The purchase id, the
 * payment and allocation ids and the exchange-rate key are minted ONCE per
 * form, so a double tap or a retry is a replay (A-12(4)). A retryable 409 is
 * retried once with the same ids (§3(c)). Every total shown is the server's;
 * the page only checks the SHAPE of what the merchant typed.
 *
 * BLOCKED BY OD-03: the draft never carries a purchase-tax amount.
 */
import { use, useEffect, useRef, useState } from 'react';
import { notFound, useRouter } from 'next/navigation';
import type { PaymentMethodDto, PurchaseCommandResultDto, PurchaseDraftRequestDto, PurchaseDto, PurchaseLandedCostRequestDto } from '@daftar/shared-contracts';
import { makeT, translate, LOCALES, type Locale } from '@/lib/i18n';
import { isUuid } from '@/lib/route-ids';
import { getCurrencies } from '@/lib/merchant-api';
import {
  cancelPurchase,
  createSupplier,
  enterExchangeRate,
  getPurchase,
  getSupplier,
  listInventoryItems,
  listInventoryWarehouses,
  listPaymentMethods,
  listSuppliers,
  putPurchaseDraft,
  receiveAndPayPurchase,
  receivePurchase,
  type InventoryItemDto,
} from '@/lib/phase3-api';
import { isMissingExchangeRate, refusalCode, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { amountInputToMinor, isQuantityText, isZeroQuantityText, localDateIso, normaliseDigits } from '@/lib/phase3-format';
import { isNonZeroMinor, minorToMajorText } from '@/views/common/amount-text';
import { PageStateView, type ExchangeRatePromptProps } from '@/views/common/feedback';
import { activeMethodChoices } from '@/views/common/payment-methods';
import { ReceivePurchaseView, type LineField, type PayField, type ReceiveHandlers } from '@/views/purchases/ReceivePurchaseView';
import {
  EXTRA_COST_KINDS,
  type ExtraCostForm,
  type ExtraCostKind,
  type ItemOption,
  type PayNowForm,
  type ReceiveForm,
  type ReceiveLineForm,
  type ReceiveResultModel,
  type ReceiveReviewModel,
  type ReceiveStep,
} from '@/views/purchases/types';
import { PageShell } from '../../AppHeader';
import { itemsById, lineNames } from '../_shared/lookups';
import { statusOfFailure, useMerchantContext } from '../_shared/merchant-context';

const SEARCH_LIMIT = 10;
const newId = (): string => crypto.randomUUID();

const emptyLine = (): ReceiveLineForm => ({
  lineId: newId(),
  item: null,
  itemSearch: '',
  itemResults: [],
  variantId: null,
  quantity: '',
  unitPrice: '',
  showDiscount: false,
  discount: '',
  errors: {},
});

const emptyForm = (currency: string, warehouseId: string): ReceiveForm => ({
  supplier: null,
  supplierSearch: '',
  supplierResults: [],
  newSupplierName: null,
  duplicateOf: null,
  warehouseId,
  documentDate: localDateIso(),
  showCurrency: false,
  currency,
  supplierReference: '',
  notes: '',
  lines: [emptyLine()],
  extraCosts: [],
  errors: {},
});

/** An item as the line picker offers it: active merchant variants only, the base variant never. */
function toItemOption(item: InventoryItemDto): ItemOption {
  return {
    productId: item.productId,
    name: item.name,
    unitDecimals: item.unitDecimals ?? 0,
    variants: item.variants.filter((v) => v.status === 'active').map((v) => ({ variantId: v.variantId, name: v.name })),
  };
}

/** The extra-cost kind whose label, in any language, is the stored description; otherwise "other". */
function kindOfDescription(description: string | null): ExtraCostKind {
  if (description === null) return 'other';
  return EXTRA_COST_KINDS.find((kind) => LOCALES.some((l) => translate(l, `purchasing.extraCost.kind.${kind}`) === description)) ?? 'other';
}

/** A typed unit price or amount, as the major-unit text the draft carries, or null when it is not one. */
function majorText(input: string, currency: string, allowZero: boolean): string | null {
  const text = normaliseDigits(input);
  const minor = amountInputToMinor(text, currency);
  if (minor === null) return null;
  if (!allowZero && !isNonZeroMinor(minor)) return null;
  return text;
}

export default function ReceivePurchasePage({ params, searchParams }: { params: Promise<{ locale: Locale }>; searchParams: Promise<{ draft?: string }> }) {
  const { locale } = use(params);
  const { draft } = use(searchParams);
  // A draft id from the URL reaches no API path unless it is a UUID (L-1).
  if (draft !== undefined && !isUuid(draft)) notFound();
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);

  const [docId, setDocId] = useState<string>(() => draft ?? newId());
  const [paymentIds, setPaymentIds] = useState(() => ({ paymentId: newId(), allocationId: newId(), fxKey: newId(), supplierId: newId() }));
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<ReceiveForm>(() => emptyForm('', ''));
  const [warehouses, setWarehouses] = useState<{ warehouseId: string; name: string }[]>([]);
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[]>([]);
  const [methods, setMethods] = useState<PaymentMethodDto[]>([]);
  const [step, setStep] = useState<ReceiveStep>('edit');
  const [review, setReview] = useState<ReceiveReviewModel | null>(null);
  const [payNow, setPayNow] = useState<PayNowForm | null>(null);
  const [result, setResult] = useState<ReceiveResultModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancelDraft, setConfirmCancelDraft] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [fx, setFx] = useState<{ currency: string; rateText: string; rateInvalid: boolean; busy: boolean } | null>(null);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'ready' | 'denied' | 'failed'>('loading');
  const search = useRef({ supplier: 0, item: 0, duplicate: 0 });

  const baseCurrency = context?.business.baseCurrency ?? '';
  const canPay = context?.can('suppliers.pay') ?? false;
  // N-7: "Paid now" changes only the receive command, so it is offered only to a member who may receive.
  const canReceive = context?.can('purchases.receive') ?? false;

  // ── Load the pickers, and the draft when continuing one ─────────────────
  useEffect(() => {
    if (status !== 'ready' || !context) return;
    if (!context.can('purchases.manage')) {
      setLoadStatus('denied');
      return;
    }
    let live = true;
    void (async () => {
      try {
        const [wh, cur, pm] = await Promise.all([
          listInventoryWarehouses(),
          getCurrencies(),
          context.can('suppliers.pay') ? listPaymentMethods() : Promise.resolve({ items: [] }),
        ]);
        const active = wh.items.filter((w) => w.status === 'active').map((w) => ({ warehouseId: w.warehouseId, name: w.name }));
        const only = active.length === 1 ? (active[0]?.warehouseId ?? '') : '';
        const loaded = draft ? await loadDraft(draft, context.business.baseCurrency) : null;
        if (!live) return;
        setWarehouses(active);
        setCurrencies(cur.items.map((c) => ({ code: c.code, name: c.name })));
        setMethods(pm.items);
        if (loaded === 'not_draft') {
          router.replace(`/${locale}/purchases/${draft ?? ''}`);
          return;
        }
        if (loaded) {
          setForm(loaded.form);
          setRevision(loaded.revision);
        } else {
          setForm(emptyForm(context.business.baseCurrency, only));
        }
        setLoadStatus('ready');
      } catch (error) {
        if (live) setLoadStatus(statusOfFailure(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [status, context, draft, locale, router]);

  async function loadDraft(purchaseId: string, base: string): Promise<{ form: ReceiveForm; revision: number } | 'not_draft'> {
    const purchase: PurchaseDto = await getPurchase(purchaseId);
    if (purchase.status !== 'draft') return 'not_draft';
    const [supplier, items] = await Promise.all([getSupplier(purchase.supplierId), itemsById(purchase.lines.map((l) => l.productId))]);
    const lines: ReceiveLineForm[] = purchase.lines.map((l) => {
      const item = items.get(l.productId);
      return {
        lineId: l.lineId,
        item: item ? toItemOption(item) : { productId: l.productId, name: lineNames(items, l.productId, null).name, unitDecimals: 0, variants: [] },
        itemSearch: '',
        itemResults: [],
        variantId: l.variantId,
        quantity: l.qty,
        unitPrice: l.unitPrice,
        showDiscount: isNonZeroMinor(l.discountTxnMinor),
        discount: isNonZeroMinor(l.discountTxnMinor) ? minorToMajorText(l.discountTxnMinor, purchase.currency) : '',
        errors: {},
      };
    });
    const extraCosts: ExtraCostForm[] = purchase.landedCosts.map((c) => ({
      landedCostId: c.landedCostId,
      kind: kindOfDescription(c.description),
      amount: minorToMajorText(c.amountTxnMinor, purchase.currency),
      manual: c.mode === 'manual',
      shares: Object.fromEntries(c.allocations.map((a) => [a.lineId, minorToMajorText(a.amountTxnMinor, purchase.currency)])),
      errors: {},
    }));
    return {
      revision: purchase.revision,
      form: {
        ...emptyForm(purchase.currency, purchase.warehouseId),
        supplier: { supplierId: supplier.id, name: supplier.name },
        documentDate: purchase.documentDate,
        showCurrency: purchase.currency !== base,
        supplierReference: purchase.supplierReference ?? '',
        notes: purchase.notes ?? '',
        lines: lines.length > 0 ? lines : [emptyLine()],
        extraCosts,
      },
    };
  }

  // ── Form edits ─────────────────────────────────────────────────────────
  const patchLine = (lineId: string, patch: (line: ReceiveLineForm) => ReceiveLineForm) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.lineId === lineId ? patch(l) : l)) }));
  const patchCost = (landedCostId: string, patch: (cost: ExtraCostForm) => ExtraCostForm) =>
    setForm((f) => ({ ...f, extraCosts: f.extraCosts.map((c) => (c.landedCostId === landedCostId ? patch(c) : c)) }));

  async function searchSuppliers(text: string) {
    setForm((f) => ({ ...f, supplierSearch: text, supplierNoMatch: false, errors: { ...f.errors, supplier: false } }));
    const ticket = ++search.current.supplier;
    const term = text.trim();
    if (term.length === 0) {
      setForm((f) => ({ ...f, supplierResults: [] }));
      return;
    }
    try {
      const page = await listSuppliers({ search: term, status: 'active', limit: SEARCH_LIMIT });
      if (ticket !== search.current.supplier) return;
      setForm((f) => ({
        ...f,
        supplierResults: page.items.map((s) => ({ supplierId: s.id, name: s.name })),
        supplierNoMatch: page.items.length === 0,
      }));
    } catch (error) {
      if (ticket === search.current.supplier) setErrorKey(refusalKey(error));
    }
  }

  async function checkDuplicate(name: string) {
    setForm((f) => ({ ...f, newSupplierName: name, duplicateOf: null }));
    const ticket = ++search.current.duplicate;
    const term = name.trim();
    if (term.length === 0) return;
    try {
      const page = await listSuppliers({ search: term, limit: SEARCH_LIMIT });
      if (ticket !== search.current.duplicate) return;
      const same = page.items.find((s) => s.name.trim().toLocaleLowerCase(locale) === term.toLocaleLowerCase(locale));
      setForm((f) => ({ ...f, duplicateOf: same ? same.name : null }));
    } catch (error) {
      if (ticket === search.current.duplicate) setErrorKey(refusalKey(error));
    }
  }

  async function addSupplier() {
    const name = (form.newSupplierName ?? '').trim();
    if (name.length === 0) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const created = await createSupplier({ supplierId: paymentIds.supplierId, name });
      setForm((f) => ({ ...f, supplier: { supplierId: created.id, name: created.name }, newSupplierName: null, duplicateOf: null, supplierResults: [] }));
      setPaymentIds((ids) => ({ ...ids, supplierId: newId() }));
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  async function searchItems(lineId: string, text: string) {
    patchLine(lineId, (l) => ({ ...l, itemSearch: text, itemNoMatch: false, errors: { ...l.errors, item: false } }));
    const ticket = ++search.current.item;
    const term = text.trim();
    if (term.length === 0) {
      patchLine(lineId, (l) => ({ ...l, itemResults: [] }));
      return;
    }
    try {
      const page = await listInventoryItems({ search: term, trackedOnly: true, limit: SEARCH_LIMIT });
      if (ticket !== search.current.item) return;
      const options = page.items.filter((i) => i.status === 'active').map(toItemOption);
      patchLine(lineId, (l) => ({ ...l, itemResults: options, itemNoMatch: options.length === 0 }));
    } catch (error) {
      if (ticket === search.current.item) setErrorKey(refusalKey(error));
    }
  }

  // ── Review: save the draft and show the server's totals ─────────────────
  function validated(): { body: PurchaseDraftRequestDto; form: ReceiveForm } | { form: ReceiveForm } {
    const currency = form.currency;
    let ok = true;
    const lines = form.lines.map((l) => {
      const quantity = normaliseDigits(l.quantity);
      const errors = {
        item: l.item === null,
        variant: l.item !== null && l.item.variants.length > 0 && l.variantId === null,
        quantity: !(l.item !== null && isQuantityText(quantity, l.item.unitDecimals) && !isZeroQuantityText(quantity)),
        unitPrice: majorText(l.unitPrice, currency, true) === null,
        discount: l.showDiscount && l.discount.trim().length > 0 && majorText(l.discount, currency, true) === null,
      };
      if (Object.values(errors).some(Boolean)) ok = false;
      return { ...l, errors };
    });
    const extraCosts = form.extraCosts.map((c) => {
      const shares = c.manual ? form.lines.map((l) => c.shares[l.lineId] ?? '') : [];
      const errors = {
        amount: majorText(c.amount, currency, false) === null,
        shares: shares.some((s) => s.trim().length > 0 && majorText(s, currency, true) === null),
      };
      if (errors.amount || errors.shares) ok = false;
      return { ...c, errors };
    });
    const errors = {
      supplier: form.supplier === null,
      warehouse: form.warehouseId === '',
      date: form.documentDate === '',
      lines: form.lines.length === 0,
    };
    if (Object.values(errors).some(Boolean)) ok = false;
    const checked: ReceiveForm = { ...form, lines, extraCosts, errors };
    if (!ok || form.supplier === null) return { form: checked };

    const landedCosts: PurchaseLandedCostRequestDto[] = form.extraCosts.map((c) => {
      const common = {
        landedCostId: c.landedCostId,
        amount: majorText(c.amount, currency, false) ?? '',
        description: t(`purchasing.extraCost.kind.${c.kind}`),
      };
      return c.manual
        ? {
            ...common,
            mode: 'manual' as const,
            allocations: form.lines.map((l) => ({ lineId: l.lineId, amount: majorText(c.shares[l.lineId] ?? '', currency, true) ?? '0' })),
          }
        : { ...common, mode: 'by_value' as const };
    });
    // BLOCKED BY OD-03: no purchase-tax amount is ever sent.
    const body: PurchaseDraftRequestDto = {
      expectedRevision: revision,
      supplierId: form.supplier.supplierId,
      warehouseId: form.warehouseId,
      currency,
      documentDate: form.documentDate,
      supplierReference: form.supplierReference.trim() || null,
      notes: form.notes.trim() || null,
      lines: form.lines.map((l) => ({
        lineId: l.lineId,
        productId: l.item?.productId ?? '',
        variantId: l.variantId,
        quantity: normaliseDigits(l.quantity),
        unitPrice: majorText(l.unitPrice, currency, true) ?? '',
        ...(l.showDiscount && l.discount.trim().length > 0 ? { discount: majorText(l.discount, currency, true) } : {}),
      })),
      landedCosts,
    };
    return { body, form: checked };
  }

  function toReview(saved: PurchaseCommandResultDto): ReceiveReviewModel {
    const byLine = new Map(form.lines.map((l) => [l.lineId, l]));
    return {
      currency: saved.currency,
      subtotalTxnMinor: saved.subtotalTxnMinor,
      landedCostTxnMinor: saved.landedCostTxnMinor,
      totalTxnMinor: saved.totalTxnMinor,
      lines: saved.lines.map((l) => {
        const line = byLine.get(l.lineId);
        const variant = line?.item?.variants.find((v) => v.variantId === l.variantId);
        return {
          lineId: l.lineId,
          name: line?.item?.name ?? '',
          variantName: variant?.name ?? null,
          qty: l.qty,
          unitDecimals: line?.item?.unitDecimals ?? 0,
          unitPrice: l.unitPrice,
          discountTxnMinor: l.discountTxnMinor,
          netTxnMinor: l.netTxnMinor,
        };
      }),
    };
  }

  async function saveAndReview() {
    const checked = validated();
    setForm(checked.form);
    if (!('body' in checked)) return;
    setBusy(true);
    setErrorKey(null);
    setFx(null);
    try {
      const saved = await putPurchaseDraft(docId, checked.body);
      setRevision(saved.revision);
      setReview(toReview(saved));
      const payable = activeMethodChoices(methods, locale, t).length > 0;
      setPayNow((prev) =>
        canPay && canReceive
          ? {
              on: payable && (prev?.on ?? false),
              methods,
              methodId: prev?.methodId ?? activeMethodChoices(methods, locale, t)[0]?.paymentMethodId ?? '',
              currencyOptions: [...new Set([saved.currency, baseCurrency])],
              payCurrency: saved.currency,
              amount: minorToMajorText(saved.totalTxnMinor, saved.currency),
              applied: '',
              reference: prev?.reference ?? '',
              errors: {},
            }
          : null,
      );
      setStep('review');
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  // ── Receive (or receive and pay) ────────────────────────────────────────
  function paymentPart(): { ok: true; payment: Parameters<typeof receiveAndPayPurchase>[1]['payment'] } | { ok: false } {
    if (!payNow || !review) return { ok: false };
    const method = activeMethodChoices(payNow.methods, locale, t).find((m) => m.paymentMethodId === payNow.methodId);
    const amountMinor = amountInputToMinor(payNow.amount, payNow.payCurrency);
    const foreign = payNow.payCurrency !== review.currency;
    const appliedMinor = foreign ? amountInputToMinor(payNow.applied, review.currency) : null;
    const errors = {
      method: method === undefined,
      amount: amountMinor === null || !isNonZeroMinor(amountMinor),
      applied: foreign && (appliedMinor === null || !isNonZeroMinor(appliedMinor)),
      reference: method?.requiresReference === true && payNow.reference.trim().length === 0,
    };
    setPayNow({ ...payNow, errors });
    if (Object.values(errors).some(Boolean) || method === undefined || amountMinor === null) return { ok: false };
    return {
      ok: true,
      payment: {
        paymentId: paymentIds.paymentId,
        allocationId: paymentIds.allocationId,
        paymentMethodId: method.paymentMethodId,
        currencyCode: payNow.payCurrency,
        amountMinor,
        ...(foreign && appliedMinor !== null ? { purchaseAmountAppliedMinor: appliedMinor } : {}),
        reference: payNow.reference.trim() || null,
      },
    };
  }

  async function receive() {
    if (!review) return;
    const paying = payNow?.on === true;
    const part = paying ? paymentPart() : null;
    if (part && !part.ok) return;
    setBusy(true);
    setErrorKey(null);
    try {
      if (part && part.ok) {
        const answer = await withConflictRetry(() => receiveAndPayPurchase(docId, { draftRevision: revision, payment: part.payment }));
        setResult({ receipt: answer.receipt, payment: answer.payment, baseCurrency });
      } else {
        const receipt = await withConflictRetry(() => receivePurchase(docId, { draftRevision: revision }));
        setResult({ receipt, payment: null, baseCurrency });
      }
      setFx(null);
      setStep('done');
    } catch (error) {
      // A missing rate is answered by the inline prompt alone, not also by the refusal text (m-1).
      setErrorKey(isMissingExchangeRate(error) ? null : refusalKey(error));
      if (isMissingExchangeRate(error)) {
        const paymentForeign = paying && payNow !== null && payNow.payCurrency !== baseCurrency;
        const currency = refusalCode(error) === 'accounting.fx_rate_missing' && paymentForeign && payNow ? payNow.payCurrency : review.currency;
        setFx({ currency, rateText: '', rateInvalid: false, busy: false });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRateAndRetry() {
    if (!fx || !context) return;
    const rate = normaliseDigits(fx.rateText);
    if (!/^\d+(\.\d{1,10})?$/.test(rate) || !/[1-9]/.test(rate)) {
      setFx({ ...fx, rateInvalid: true });
      return;
    }
    setFx({ ...fx, rateInvalid: false, busy: true });
    setErrorKey(null);
    try {
      await enterExchangeRate(
        context.business.businessId,
        { fromCurrency: fx.currency, toCurrency: baseCurrency, rate, effectiveAt: `${form.documentDate}T00:00:00Z` },
        paymentIds.fxKey,
      );
      // The rate is saved: a second, different rate in this form gets its own key (L-4, m-2).
      setPaymentIds((ids) => ({ ...ids, fxKey: newId() }));
      setFx(null);
      await receive();
    } catch (error) {
      setErrorKey(refusalKey(error));
      setFx((f) => (f ? { ...f, busy: false } : f));
    }
  }

  async function cancelDraft() {
    setBusy(true);
    setErrorKey(null);
    try {
      await cancelPurchase(docId, { draftRevision: revision });
      router.push(`/${locale}/purchases`);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setConfirmCancelDraft(false);
      setBusy(false);
    }
  }

  function startAnother() {
    setDocId(newId());
    setPaymentIds({ paymentId: newId(), allocationId: newId(), fxKey: newId(), supplierId: newId() });
    setRevision(0);
    setForm(emptyForm(baseCurrency, warehouses.length === 1 ? (warehouses[0]?.warehouseId ?? '') : ''));
    setReview(null);
    setPayNow(null);
    setResult(null);
    setErrorKey(null);
    setFx(null);
    setStep('edit');
    if (draft) router.replace(`/${locale}/purchases/receive`);
  }

  const on: ReceiveHandlers = {
    onSupplierSearch: (text) => void searchSuppliers(text),
    onPickSupplier: (supplier) => setForm((f) => ({ ...f, supplier, supplierResults: [], supplierSearch: '' })),
    onClearSupplier: () => setForm((f) => ({ ...f, supplier: null })),
    onStartNewSupplier: () => setForm((f) => ({ ...f, newSupplierName: f.supplierSearch, duplicateOf: null })),
    onNewSupplierName: (name) => void checkDuplicate(name),
    onCreateSupplier: () => void addSupplier(),
    onCancelNewSupplier: () => setForm((f) => ({ ...f, newSupplierName: null, duplicateOf: null })),
    onWarehouse: (warehouseId) => setForm((f) => ({ ...f, warehouseId, errors: { ...f.errors, warehouse: false } })),
    onDate: (documentDate) => setForm((f) => ({ ...f, documentDate, errors: { ...f.errors, date: false } })),
    onToggleCurrency: () => setForm((f) => ({ ...f, showCurrency: true })),
    onCurrency: (currency) => setForm((f) => ({ ...f, currency })),
    onReference: (supplierReference) => setForm((f) => ({ ...f, supplierReference })),
    onNotes: (notes) => setForm((f) => ({ ...f, notes })),
    onAddLine: () => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()], errors: { ...f.errors, lines: false } })),
    onRemoveLine: (lineId) =>
      setForm((f) => ({
        ...f,
        lines: f.lines.filter((l) => l.lineId !== lineId),
        extraCosts: f.extraCosts.map((c) => ({ ...c, shares: Object.fromEntries(Object.entries(c.shares).filter(([id]) => id !== lineId)) })),
      })),
    onLineItemSearch: (lineId, text) => void searchItems(lineId, text),
    onPickItem: (lineId, item) =>
      patchLine(lineId, (l) => ({
        ...l,
        item,
        itemResults: [],
        itemSearch: '',
        variantId: item.variants.length === 1 ? (item.variants[0]?.variantId ?? null) : null,
      })),
    onClearItem: (lineId) => patchLine(lineId, (l) => ({ ...l, item: null, variantId: null })),
    onLineVariant: (lineId, variantId) => patchLine(lineId, (l) => ({ ...l, variantId: variantId === '' ? null : variantId })),
    onLineField: (lineId, field: LineField, value) => patchLine(lineId, (l) => ({ ...l, [field]: value, errors: { ...l.errors, [field]: false } })),
    onToggleDiscount: (lineId) => patchLine(lineId, (l) => ({ ...l, showDiscount: true })),
    onAddExtraCost: () =>
      setForm((f) => ({ ...f, extraCosts: [...f.extraCosts, { landedCostId: newId(), kind: 'shipping', amount: '', manual: false, shares: {}, errors: {} }] })),
    onRemoveExtraCost: (id) => setForm((f) => ({ ...f, extraCosts: f.extraCosts.filter((c) => c.landedCostId !== id) })),
    onExtraCostKind: (id, kind) => patchCost(id, (c) => ({ ...c, kind })),
    onExtraCostAmount: (id, amount) => patchCost(id, (c) => ({ ...c, amount, errors: { ...c.errors, amount: false } })),
    onToggleManualSplit: (id) => patchCost(id, (c) => ({ ...c, manual: !c.manual })),
    onExtraCostShare: (id, lineId, value) => patchCost(id, (c) => ({ ...c, shares: { ...c.shares, [lineId]: value }, errors: { ...c.errors, shares: false } })),
    onReview: () => void saveAndReview(),
    onBackToEdit: () => {
      setStep('edit');
      setFx(null);
      setErrorKey(null);
    },
    onTogglePayNow: () => setPayNow((p) => (p && activeMethodChoices(p.methods, locale, t).length > 0 ? { ...p, on: !p.on } : p)),
    onPayField: (field: PayField, value) =>
      setPayNow((p) => (p ? { ...p, [field]: value, errors: { ...p.errors, [field === 'methodId' ? 'method' : field]: false } } : p)),
    onReceive: () => void receive(),
    onAskCancelDraft: () => setConfirmCancelDraft(true),
    onDismissCancelDraft: () => setConfirmCancelDraft(false),
    onCancelDraft: () => void cancelDraft(),
    onNewPurchase: startAnother,
  };

  const exchangeRate: ExchangeRatePromptProps | null =
    fx && context
      ? {
          date: form.documentDate,
          currency: fx.currency,
          baseCurrency,
          canEnter: context.can('accounting.fx.manage') && context.access.businessWide,
          rateText: fx.rateText,
          rateInvalid: fx.rateInvalid,
          busy: fx.busy,
          onRateChange: (rateText) => setFx((f) => (f ? { ...f, rateText, rateInvalid: false } : f)),
          onSubmit: () => void saveRateAndRetry(),
        }
      : null;

  // "Try again" shows the spinner at once, not the failed state again until the data arrives (N-9).
  const retryLoad = () => {
    setLoadStatus('loading');
    retry();
  };

  const pageStatus = status !== 'ready' ? status : loadStatus;
  return (
    <PageShell locale={locale} active="purchases">
      {pageStatus !== 'ready' || !context ? (
        <PageStateView t={t} locale={locale} status={pageStatus === 'ready' ? 'loading' : pageStatus} onRetry={retryLoad} />
      ) : (
        <ReceivePurchaseView
          t={t}
          locale={locale}
          step={step}
          form={form}
          warehouses={warehouses}
          currencies={currencies}
          baseCurrency={baseCurrency}
          canCreateSupplier={context.can('suppliers.manage')}
          canReceive={canReceive}
          savedDraft={revision > 0}
          confirmCancelDraft={confirmCancelDraft}
          review={review}
          payNow={payNow}
          result={result}
          busy={busy}
          errorKey={errorKey}
          exchangeRate={exchangeRate}
          on={on}
        />
      )}
    </PageShell>
  );
}
