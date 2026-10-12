import type { ConsentReader, RecipientPreferences } from '../src/preferences';
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

/**
 * Mission §15 — consent is READ, never carried. These helpers make the number
 * of reads and their answers observable, which is the only way to prove that a
 * withdrawal between enqueue and send actually stops the send.
 */
export interface RecordingConsent extends ConsentReader {
  readonly reads: number;
}

/** Always answers the same thing. Counts how many times it was asked. */
export function consentOf(preferences: RecipientPreferences = { channels: [] }): RecordingConsent {
  let reads = 0;
  return {
    read(): RecipientPreferences {
      reads += 1;
      return preferences;
    },
    get reads() {
      return reads;
    },
  };
}

/**
 * Answers each read from the list in order, repeating the last answer once the
 * list runs out. `consentThen(allowed, withdrawn)` is the withdrawal case: the
 * enqueue read allows and the read before the send refuses.
 */
export function consentSequence(...answers: readonly RecipientPreferences[]): RecordingConsent {
  let reads = 0;
  return {
    read(): RecipientPreferences {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      if (answer === undefined) throw new Error('consentSequence needs at least one answer');
      return answer;
    },
    get reads() {
      return reads;
    },
  };
}

export const OPTED_OUT_WHATSAPP: RecipientPreferences = { channels: [{ channel: 'whatsapp', state: 'opted_out' }] };
export const NOTHING_RECORDED: RecipientPreferences = { channels: [] };
