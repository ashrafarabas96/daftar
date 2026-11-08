import { describe, expect, it } from 'vitest';
import { renderNotification, renderWithTemplate } from '../src/render';
import { template } from '../src/template-registry';
import { NotificationRefusal } from '../src/errors';
import type { NotificationKind } from '../src/catalog';
import { dateFormatter, moneyFormatter } from './helpers';
import type { TemplateVars } from '../src/types';

const invoiceVars: TemplateVars = {
  customerName: { kind: 'text', text: 'أشرف' },
  invoiceNumber: { kind: 'text', text: 'INV-2026-000041' },
  invoiceTotal: { kind: 'money', money: { minor: '125000', currency: 'ILS' } },
};

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof NotificationRefusal) return e.code;
    throw e;
  }
  throw new Error('expected a refusal, got a value');
}

describe('render', () => {
  it('renders the Arabic invoice notification with money through the port', () => {
    const out = renderNotification({ kind: 'invoice_issued', locale: 'ar', channel: 'email', vars: invoiceVars, moneyFormatter, dateFormatter });
    expect(out.subject).toBe('فاتورة جديدة INV-2026-000041');
    expect(out.body).toBe('مرحبًا أشرف، صدرت فاتورتك رقم INV-2026-000041 بمبلغ [ar]125000ILS.');
    // The renderer never formats money itself: the exact port output appears.
    expect(out.body).toContain('[ar]125000ILS');
  });

  it('renders all three locales and leaves no placeholder behind', () => {
    for (const locale of ['ar', 'en', 'tr'] as const) {
      const out = renderNotification({ kind: 'invoice_issued', locale, channel: 'email', vars: invoiceVars, moneyFormatter, dateFormatter });
      expect(out.body).not.toContain('{{');
      expect(out.subject).not.toContain('{{');
      expect(out.body).toContain(`[${locale}]125000ILS`);
    }
  });

  it('gives WhatsApp the approved template name and ordered parameters', () => {
    const out = renderNotification({ kind: 'invoice_issued', locale: 'en', channel: 'whatsapp', vars: invoiceVars, moneyFormatter, dateFormatter });
    expect(out.providerTemplate).toEqual({
      name: 'daftar_invoice_issued',
      locale: 'en',
      parameters: ['أشرف', 'INV-2026-000041', '[en]125000ILS'],
    });
  });

  it('leaves the subject empty for sms and inapp (there is no subject line)', () => {
    const vars: TemplateVars = {
      customerName: { kind: 'text', text: 'Ashraf' },
      dueDate: { kind: 'date', iso: '2026-11-01' },
      dueAmount: { kind: 'money', money: { minor: '5000', currency: 'ILS' } },
    };
    const out = renderNotification({ kind: 'installment_due_soon', locale: 'en', channel: 'sms', vars, moneyFormatter, dateFormatter });
    expect(out.subject).toBe('');
    expect(out.body).toContain('[en]2026-11-01');
  });

  it('refuses an unknown kind', () => {
    expect(
      refusalOf(() =>
        renderNotification({ kind: 'invoice_cancelled' as NotificationKind, locale: 'en', channel: 'email', vars: {}, moneyFormatter, dateFormatter }),
      ),
    ).toBe('notification.template_missing');
  });

  it('refuses a channel the kind may not use', () => {
    // customer_statement is whatsapp+email only: no sms, by catalog decision.
    expect(refusalOf(() => renderNotification({ kind: 'customer_statement', locale: 'en', channel: 'sms', vars: {}, moneyFormatter, dateFormatter }))).toBe(
      'notification.channel_not_supported_for_kind',
    );
  });

  it('refuses a missing variable instead of rendering a blank', () => {
    const { customerName: _omitted, ...rest } = invoiceVars;
    expect(refusalOf(() => renderNotification({ kind: 'invoice_issued', locale: 'en', channel: 'email', vars: rest, moneyFormatter, dateFormatter }))).toBe(
      'notification.template_variable_missing',
    );
  });

  it('refuses a variable of the wrong type — text where money is declared', () => {
    const wrong: TemplateVars = { ...invoiceVars, invoiceTotal: { kind: 'text', text: '1250.00' } };
    expect(refusalOf(() => renderNotification({ kind: 'invoice_issued', locale: 'en', channel: 'email', vars: wrong, moneyFormatter, dateFormatter }))).toBe(
      'notification.template_variable_type_mismatch',
    );
  });

  it('refuses a non-integer int rather than printing 3.5 items', () => {
    const vars: TemplateVars = {
      productName: { kind: 'text', text: 'Widget' },
      onHand: { kind: 'int', value: 3.5 },
      threshold: { kind: 'int', value: 5 },
    };
    expect(refusalOf(() => renderNotification({ kind: 'low_stock_alert', locale: 'en', channel: 'email', vars, moneyFormatter, dateFormatter }))).toBe(
      'notification.template_variable_type_mismatch',
    );
  });

  it('refuses to render money with no formatter — never the raw minor units', () => {
    expect(refusalOf(() => renderNotification({ kind: 'invoice_issued', locale: 'en', channel: 'email', vars: invoiceVars, dateFormatter }))).toBe(
      'notification.money_formatter_missing',
    );
  });

  it('refuses to render a date with no formatter', () => {
    const vars: TemplateVars = {
      customerName: { kind: 'text', text: 'Ashraf' },
      dueDate: { kind: 'date', iso: '2026-11-01' },
      dueAmount: { kind: 'money', money: { minor: '5000', currency: 'ILS' } },
    };
    expect(refusalOf(() => renderNotification({ kind: 'installment_due_soon', locale: 'en', channel: 'sms', vars, moneyFormatter }))).toBe(
      'notification.date_formatter_missing',
    );
  });

  it('refuses an undeclared placeholder (the guard the registry law protects)', () => {
    // Unreachable through renderNotification while L2 holds, so it is proven
    // through the explicit-template seam with a template that breaks L2.
    const live = template('invoice_issued', 'en');
    expect(live).toBeDefined();
    if (!live) return;
    const broken = { ...live, body: `${live.body} {{secretDiscount}}` };
    expect(broken.body).not.toBe(live.body);
    expect(
      refusalOf(() => renderWithTemplate({ kind: 'invoice_issued', locale: 'en', channel: 'email', vars: invoiceVars, moneyFormatter, dateFormatter }, broken)),
    ).toBe('notification.template_variable_unknown');
  });

  it('refuses when the ordered WhatsApp parameters ask for a value the text never supplied', () => {
    const live = template('invoice_issued', 'en');
    expect(live).toBeDefined();
    if (!live) return;
    const broken = { ...live, whatsappParameters: [...live.whatsappParameters, 'dueDate'] };
    expect(broken.whatsappParameters.length).toBe(live.whatsappParameters.length + 1);
    expect(
      refusalOf(() =>
        renderWithTemplate({ kind: 'invoice_issued', locale: 'en', channel: 'whatsapp', vars: invoiceVars, moneyFormatter, dateFormatter }, broken),
      ),
    ).toBe('notification.template_variable_missing');
  });
});
