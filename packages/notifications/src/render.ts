/**
 * The renderer. Deterministic, pure, and refusing: every placeholder must be
 * declared in the catalog AND supplied by the caller, with the declared type.
 * There is no default value, no empty-string fallback and no partial render —
 * a notification about money is either exactly right or it is refused.
 */
import { refuse } from './errors';
import { catalogEntry, type KindVariable, type NotificationKind } from './catalog';
import { placeholdersOf, template, type TemplateEntry } from './template-registry';
import type { Channel, DateFormatter, Locale, MoneyFormatter, RenderedMessage, TemplateValue, TemplateVars } from './types';

export interface RenderRequest {
  readonly kind: NotificationKind;
  readonly locale: Locale;
  readonly channel: Channel;
  readonly vars: TemplateVars;
  readonly moneyFormatter?: MoneyFormatter;
  readonly dateFormatter?: DateFormatter;
}

function typeOfValue(v: TemplateValue): KindVariable['type'] {
  return v.kind;
}

function display(name: string, value: TemplateValue, locale: Locale, req: RenderRequest): string {
  switch (value.kind) {
    case 'text':
      return value.text;
    case 'money': {
      if (!req.moneyFormatter) refuse('notification.money_formatter_missing', name);
      return req.moneyFormatter.format(value.money, locale);
    }
    case 'date': {
      if (!req.dateFormatter) refuse('notification.date_formatter_missing', name);
      return req.dateFormatter.format(value.iso, locale);
    }
    case 'int': {
      if (!Number.isInteger(value.value)) refuse('notification.template_variable_type_mismatch', name);
      return String(value.value);
    }
  }
}

/**
 * Production entry point: the template comes from the live registry and from
 * nowhere else.
 */
export function renderNotification(req: RenderRequest): RenderedMessage {
  const tpl = template(req.kind, req.locale);
  if (!tpl) refuse('notification.template_missing', `${req.kind}/${req.locale}`);
  return renderWithTemplate(req, tpl);
}

/**
 * The same renderer over an EXPLICIT template. This is the seam the red proofs
 * use: the registry-level guards (an undeclared placeholder, a required
 * variable the text never uses) are unreachable while the registry laws hold,
 * so the only way to prove they fire is to hand the renderer a template that
 * breaks one. Production code calls renderNotification; this function exists so
 * that "the guard works" is a measurement rather than a claim.
 */
export function renderWithTemplate(req: RenderRequest, tpl: TemplateEntry): RenderedMessage {
  const entry = catalogEntry(req.kind);
  if (!entry) refuse('notification.kind_unknown', req.kind);
  if (!entry.channels.includes(req.channel)) refuse('notification.channel_not_supported_for_kind', `${req.kind}/${req.channel}`);

  const declared = new Map<string, KindVariable>(entry.variables.map((v) => [v.name, v]));
  const used = [...new Set([...placeholdersOf(tpl.subject), ...placeholdersOf(tpl.body)])];

  // A template may not invent a variable the catalog never declared.
  for (const name of used) {
    if (!declared.has(name)) refuse('notification.template_variable_unknown', `${req.kind}/${req.locale}/${name}`);
  }

  // Every placeholder, and every REQUIRED declared variable, must be supplied.
  const needed = new Set<string>(used);
  for (const v of entry.variables) if (v.required) needed.add(v.name);

  const rendered = new Map<string, string>();
  for (const name of needed) {
    const value = req.vars[name];
    if (value === undefined) refuse('notification.template_variable_missing', `${req.kind}/${name}`);
    const spec = declared.get(name);
    if (!spec) refuse('notification.template_variable_unknown', `${req.kind}/${name}`);
    if (typeOfValue(value) !== spec.type) refuse('notification.template_variable_type_mismatch', `${req.kind}/${name}`);
    rendered.set(name, display(name, value, req.locale, req));
  }

  const substitute = (text: string): string =>
    text.replaceAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_whole, name: string) => {
      const value = rendered.get(name);
      if (value === undefined) refuse('notification.template_variable_missing', `${req.kind}/${name}`);
      return value;
    });

  const subject = substitute(tpl.subject);
  const body = substitute(tpl.body);

  // Belt and braces: a surviving placeholder would ship `{{` to a customer.
  if (body.includes('{{') || subject.includes('{{')) refuse('notification.template_variable_missing', `${req.kind}/${req.locale}`);

  if (req.channel === 'whatsapp') {
    const parameters: string[] = [];
    for (const name of tpl.whatsappParameters) {
      const value = rendered.get(name);
      if (value === undefined) refuse('notification.template_variable_missing', `${req.kind}/whatsapp/${name}`);
      parameters.push(value);
    }
    return {
      channel: req.channel,
      locale: req.locale,
      subject,
      body,
      providerTemplate: { name: tpl.whatsappTemplateName, locale: req.locale, parameters },
    };
  }

  return { channel: req.channel, locale: req.locale, subject: req.channel === 'email' ? subject : '', body };
}
