/**
 * The template registry: one entry per (kind, locale), all three product
 * locales mandatory. A missing locale is a registry defect, not a runtime
 * fallback — a customer who reads Arabic must never receive English money.
 *
 * Placeholders are `{{name}}` and nothing else: no expressions, no conditionals,
 * no loops. A template cannot compute, so a template cannot compute money.
 *
 * `whatsappTemplateName` + `whatsappParameters` exist because the official
 * WhatsApp Cloud API will not accept free prose outside the 24-hour service
 * window: it accepts an APPROVED template name and ordered parameters. The
 * ordered list is part of the registry so the approved template and the code
 * cannot drift apart silently.
 */
import type { Locale } from './types';
import type { NotificationKind } from './catalog';

export interface TemplateEntry {
  readonly kind: NotificationKind;
  readonly locale: Locale;
  /** Email subject. Short channels ignore it. */
  readonly subject: string;
  readonly body: string;
  readonly whatsappTemplateName: string;
  /** Ordered placeholder NAMES (not values) matching the approved template. */
  readonly whatsappParameters: readonly string[];
}

const T: readonly TemplateEntry[] = [
  // ── invoice_issued ───────────────────────────────────────────────────────
  {
    kind: 'invoice_issued',
    locale: 'ar',
    subject: 'فاتورة جديدة {{invoiceNumber}}',
    body: 'مرحبًا {{customerName}}، صدرت فاتورتك رقم {{invoiceNumber}} بمبلغ {{invoiceTotal}}.',
    whatsappTemplateName: 'daftar_invoice_issued',
    whatsappParameters: ['customerName', 'invoiceNumber', 'invoiceTotal'],
  },
  {
    kind: 'invoice_issued',
    locale: 'en',
    subject: 'New invoice {{invoiceNumber}}',
    body: 'Hello {{customerName}}, your invoice {{invoiceNumber}} for {{invoiceTotal}} has been issued.',
    whatsappTemplateName: 'daftar_invoice_issued',
    whatsappParameters: ['customerName', 'invoiceNumber', 'invoiceTotal'],
  },
  {
    kind: 'invoice_issued',
    locale: 'tr',
    subject: 'Yeni fatura {{invoiceNumber}}',
    body: 'Merhaba {{customerName}}, {{invoiceNumber}} numaralı {{invoiceTotal}} tutarındaki faturanız oluşturuldu.',
    whatsappTemplateName: 'daftar_invoice_issued',
    whatsappParameters: ['customerName', 'invoiceNumber', 'invoiceTotal'],
  },
  // ── payment_receipt ──────────────────────────────────────────────────────
  {
    kind: 'payment_receipt',
    locale: 'ar',
    subject: 'إيصال دفعة',
    body: 'شكرًا {{customerName}}. استلمنا {{paidAmount}} بتاريخ {{paymentDate}}. المتبقي عليك {{outstandingAfter}}.',
    whatsappTemplateName: 'daftar_payment_receipt',
    whatsappParameters: ['customerName', 'paidAmount', 'paymentDate', 'outstandingAfter'],
  },
  {
    kind: 'payment_receipt',
    locale: 'en',
    subject: 'Payment receipt',
    body: 'Thank you {{customerName}}. We received {{paidAmount}} on {{paymentDate}}. Your remaining balance is {{outstandingAfter}}.',
    whatsappTemplateName: 'daftar_payment_receipt',
    whatsappParameters: ['customerName', 'paidAmount', 'paymentDate', 'outstandingAfter'],
  },
  {
    kind: 'payment_receipt',
    locale: 'tr',
    subject: 'Ödeme makbuzu',
    body: 'Teşekkürler {{customerName}}. {{paymentDate}} tarihinde {{paidAmount}} tahsil edildi. Kalan bakiyeniz {{outstandingAfter}}.',
    whatsappTemplateName: 'daftar_payment_receipt',
    whatsappParameters: ['customerName', 'paidAmount', 'paymentDate', 'outstandingAfter'],
  },
  // ── credit_applied ───────────────────────────────────────────────────────
  {
    kind: 'credit_applied',
    locale: 'ar',
    subject: 'استخدام رصيد دائن',
    body: 'مرحبًا {{customerName}}، تم تطبيق {{appliedAmount}} من رصيدك على الفاتورة {{invoiceNumber}}.',
    whatsappTemplateName: 'daftar_credit_applied',
    whatsappParameters: ['customerName', 'appliedAmount', 'invoiceNumber'],
  },
  {
    kind: 'credit_applied',
    locale: 'en',
    subject: 'Credit applied',
    body: 'Hello {{customerName}}, {{appliedAmount}} of your credit was applied to invoice {{invoiceNumber}}.',
    whatsappTemplateName: 'daftar_credit_applied',
    whatsappParameters: ['customerName', 'appliedAmount', 'invoiceNumber'],
  },
  {
    kind: 'credit_applied',
    locale: 'tr',
    subject: 'Alacak kullanıldı',
    body: 'Merhaba {{customerName}}, alacağınızdan {{appliedAmount}} tutarı {{invoiceNumber}} numaralı faturaya uygulandı.',
    whatsappTemplateName: 'daftar_credit_applied',
    whatsappParameters: ['customerName', 'appliedAmount', 'invoiceNumber'],
  },
  // ── customer_statement ───────────────────────────────────────────────────
  {
    kind: 'customer_statement',
    locale: 'ar',
    subject: 'كشف حساب حتى {{periodEnd}}',
    body: 'مرحبًا {{customerName}}، رصيدك المستحق حتى {{periodEnd}} هو {{outstanding}}.',
    whatsappTemplateName: 'daftar_customer_statement',
    whatsappParameters: ['customerName', 'periodEnd', 'outstanding'],
  },
  {
    kind: 'customer_statement',
    locale: 'en',
    subject: 'Statement as of {{periodEnd}}',
    body: 'Hello {{customerName}}, your outstanding balance as of {{periodEnd}} is {{outstanding}}.',
    whatsappTemplateName: 'daftar_customer_statement',
    whatsappParameters: ['customerName', 'periodEnd', 'outstanding'],
  },
  {
    kind: 'customer_statement',
    locale: 'tr',
    subject: '{{periodEnd}} tarihli hesap özeti',
    body: 'Merhaba {{customerName}}, {{periodEnd}} tarihi itibarıyla bakiyeniz {{outstanding}}.',
    whatsappTemplateName: 'daftar_customer_statement',
    whatsappParameters: ['customerName', 'periodEnd', 'outstanding'],
  },
  // ── installment_due_soon ─────────────────────────────────────────────────
  {
    kind: 'installment_due_soon',
    locale: 'ar',
    subject: 'قسط يستحق قريبًا',
    body: 'مرحبًا {{customerName}}، قسطك بمبلغ {{dueAmount}} يستحق بتاريخ {{dueDate}}.',
    whatsappTemplateName: 'daftar_installment_due_soon',
    whatsappParameters: ['customerName', 'dueAmount', 'dueDate'],
  },
  {
    kind: 'installment_due_soon',
    locale: 'en',
    subject: 'Instalment due soon',
    body: 'Hello {{customerName}}, your instalment of {{dueAmount}} is due on {{dueDate}}.',
    whatsappTemplateName: 'daftar_installment_due_soon',
    whatsappParameters: ['customerName', 'dueAmount', 'dueDate'],
  },
  {
    kind: 'installment_due_soon',
    locale: 'tr',
    subject: 'Yaklaşan taksit',
    body: 'Merhaba {{customerName}}, {{dueAmount}} tutarındaki taksitinizin vadesi {{dueDate}}.',
    whatsappTemplateName: 'daftar_installment_due_soon',
    whatsappParameters: ['customerName', 'dueAmount', 'dueDate'],
  },
  // ── installment_overdue ──────────────────────────────────────────────────
  {
    kind: 'installment_overdue',
    locale: 'ar',
    subject: 'قسط متأخر',
    body: 'مرحبًا {{customerName}}، قسطك بمبلغ {{dueAmount}} المستحق بتاريخ {{dueDate}} متأخر {{daysOverdue}} يومًا.',
    whatsappTemplateName: 'daftar_installment_overdue',
    whatsappParameters: ['customerName', 'dueAmount', 'dueDate', 'daysOverdue'],
  },
  {
    kind: 'installment_overdue',
    locale: 'en',
    subject: 'Instalment overdue',
    body: 'Hello {{customerName}}, your instalment of {{dueAmount}} due on {{dueDate}} is {{daysOverdue}} days overdue.',
    whatsappTemplateName: 'daftar_installment_overdue',
    whatsappParameters: ['customerName', 'dueAmount', 'dueDate', 'daysOverdue'],
  },
  {
    kind: 'installment_overdue',
    locale: 'tr',
    subject: 'Gecikmiş taksit',
    body: 'Merhaba {{customerName}}, {{dueDate}} vadeli {{dueAmount}} tutarındaki taksitiniz {{daysOverdue}} gün gecikmiş.',
    whatsappTemplateName: 'daftar_installment_overdue',
    whatsappParameters: ['customerName', 'dueAmount', 'dueDate', 'daysOverdue'],
  },
  // ── daily_sales_report (staff) ───────────────────────────────────────────
  {
    kind: 'daily_sales_report',
    locale: 'ar',
    subject: 'تقرير مبيعات {{reportDate}}',
    body: 'مبيعات {{reportDate}}: {{salesTotal}} عبر {{invoiceCount}} فاتورة.',
    whatsappTemplateName: 'daftar_daily_sales_report',
    whatsappParameters: ['reportDate', 'salesTotal', 'invoiceCount'],
  },
  {
    kind: 'daily_sales_report',
    locale: 'en',
    subject: 'Sales report {{reportDate}}',
    body: 'Sales for {{reportDate}}: {{salesTotal}} across {{invoiceCount}} invoices.',
    whatsappTemplateName: 'daftar_daily_sales_report',
    whatsappParameters: ['reportDate', 'salesTotal', 'invoiceCount'],
  },
  {
    kind: 'daily_sales_report',
    locale: 'tr',
    subject: '{{reportDate}} satış raporu',
    body: '{{reportDate}} satışları: {{invoiceCount}} fatura karşılığı {{salesTotal}}.',
    whatsappTemplateName: 'daftar_daily_sales_report',
    whatsappParameters: ['reportDate', 'salesTotal', 'invoiceCount'],
  },
  // ── low_stock_alert (staff) ──────────────────────────────────────────────
  {
    kind: 'low_stock_alert',
    locale: 'ar',
    subject: 'تنبيه مخزون منخفض',
    body: 'المنتج {{productName}}: المتوفر {{onHand}} وحد التنبيه {{threshold}}.',
    whatsappTemplateName: 'daftar_low_stock_alert',
    whatsappParameters: ['productName', 'onHand', 'threshold'],
  },
  {
    kind: 'low_stock_alert',
    locale: 'en',
    subject: 'Low stock alert',
    body: 'Product {{productName}}: {{onHand}} on hand, alert threshold {{threshold}}.',
    whatsappTemplateName: 'daftar_low_stock_alert',
    whatsappParameters: ['productName', 'onHand', 'threshold'],
  },
  {
    kind: 'low_stock_alert',
    locale: 'tr',
    subject: 'Düşük stok uyarısı',
    body: '{{productName}} ürünü: eldeki {{onHand}}, uyarı eşiği {{threshold}}.',
    whatsappTemplateName: 'daftar_low_stock_alert',
    whatsappParameters: ['productName', 'onHand', 'threshold'],
  },
];

const KEY = (kind: string, locale: string): string => `${kind}::${locale}`;
const BY_KEY = new Map<string, TemplateEntry>(T.map((e) => [KEY(e.kind, e.locale), e]));

export function templateEntries(): readonly TemplateEntry[] {
  return T;
}

export function template(kind: NotificationKind, locale: Locale): TemplateEntry | undefined {
  return BY_KEY.get(KEY(kind, locale));
}

/** The placeholder names a template text actually uses, in first-appearance order. */
export function placeholdersOf(text: string): readonly string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) {
    const name = m[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}
