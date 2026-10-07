import type { DateFormatter, Locale, MoneyFormatter, MoneyRef } from '../src/types';

/**
 * Deterministic formatters. They do NOT reimplement @daftar/domain-core's
 * Intl formatter — at promotion the adapter injects that one. Their job here is
 * to make the renderer's output exact, and to prove the renderer never reaches
 * into a money value itself: the string a test sees is the string the port
 * returned, minor units and all.
 */
export const moneyFormatter: MoneyFormatter = {
  format(money: MoneyRef, locale: Locale): string {
    return `[${locale}]${money.minor}${money.currency}`;
  },
};

export const dateFormatter: DateFormatter = {
  format(iso: string, locale: Locale): string {
    return `[${locale}]${iso}`;
  },
};
