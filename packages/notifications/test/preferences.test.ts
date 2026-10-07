import { describe, expect, it } from 'vitest';
import { evaluateConsent, type RecipientPreferences } from '../src/preferences';

const prefs = (over: Partial<RecipientPreferences> = {}): RecipientPreferences => ({ channels: [], ...over });

describe('consent', () => {
  it('delivers a transactional notification with no preference recorded', () => {
    expect(evaluateConsent({ consent: 'transactional', channel: 'whatsapp', preferences: prefs(), nowMinuteOfDay: 600 })).toEqual({ decision: 'allow' });
  });

  it('refuses a transactional notification on a channel the recipient opted out of', () => {
    const p = prefs({ channels: [{ channel: 'whatsapp', state: 'opted_out' }] });
    expect(evaluateConsent({ consent: 'transactional', channel: 'whatsapp', preferences: p, nowMinuteOfDay: 600 })).toEqual({
      decision: 'refuse',
      code: 'notification.channel_blocked',
    });
  });

  it('refuses marketing while consent is unset — silence is not a yes', () => {
    expect(evaluateConsent({ consent: 'marketing', channel: 'whatsapp', preferences: prefs(), nowMinuteOfDay: 600 })).toEqual({
      decision: 'refuse',
      code: 'notification.consent_missing',
    });
  });

  it('delivers marketing only on an explicit opt-in', () => {
    const p = prefs({ channels: [{ channel: 'whatsapp', state: 'opted_in' }] });
    expect(evaluateConsent({ consent: 'marketing', channel: 'whatsapp', preferences: p, nowMinuteOfDay: 600 })).toEqual({ decision: 'allow' });
  });

  it('never silences the in-app record — not by opt-out, not by quiet hours', () => {
    const p = prefs({ channels: [{ channel: 'inapp', state: 'opted_out' }], quietHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439 } });
    expect(evaluateConsent({ consent: 'transactional', channel: 'inapp', preferences: p, nowMinuteOfDay: 10 })).toEqual({ decision: 'allow' });
  });

  it('defers inside quiet hours and names the minute it becomes deliverable', () => {
    const p = prefs({ quietHours: { startMinuteOfDay: 1320, endMinuteOfDay: 420 } }); // 22:00 → 07:00
    expect(evaluateConsent({ consent: 'transactional', channel: 'whatsapp', preferences: p, nowMinuteOfDay: 180 })).toEqual({
      decision: 'defer',
      deferUntilMinuteOfDay: 420,
    });
    expect(evaluateConsent({ consent: 'transactional', channel: 'whatsapp', preferences: p, nowMinuteOfDay: 1350 })).toEqual({
      decision: 'defer',
      deferUntilMinuteOfDay: 420,
    });
  });

  it('delivers outside the wrapped quiet window', () => {
    const p = prefs({ quietHours: { startMinuteOfDay: 1320, endMinuteOfDay: 420 } });
    expect(evaluateConsent({ consent: 'transactional', channel: 'whatsapp', preferences: p, nowMinuteOfDay: 420 })).toEqual({ decision: 'allow' });
    expect(evaluateConsent({ consent: 'transactional', channel: 'whatsapp', preferences: p, nowMinuteOfDay: 1319 })).toEqual({ decision: 'allow' });
  });

  it('treats a zero-width quiet window as silencing nothing', () => {
    const p = prefs({ quietHours: { startMinuteOfDay: 600, endMinuteOfDay: 600 } });
    expect(evaluateConsent({ consent: 'transactional', channel: 'sms', preferences: p, nowMinuteOfDay: 600 })).toEqual({ decision: 'allow' });
  });

  it('an opt-out beats quiet hours: a blocked channel is refused, not deferred', () => {
    const p = prefs({ channels: [{ channel: 'sms', state: 'opted_out' }], quietHours: { startMinuteOfDay: 0, endMinuteOfDay: 1439 } });
    expect(evaluateConsent({ consent: 'transactional', channel: 'sms', preferences: p, nowMinuteOfDay: 10 })).toEqual({
      decision: 'refuse',
      code: 'notification.channel_blocked',
    });
  });

  it('refuses a minute-of-day outside [0,1440) rather than guessing the hour', () => {
    for (const minute of [-1, 1440, 1.5, Number.NaN]) {
      expect(evaluateConsent({ consent: 'transactional', channel: 'sms', preferences: prefs(), nowMinuteOfDay: minute }).decision).toBe('refuse');
    }
  });

  it('refuses an operational notification on an opted-out channel', () => {
    const p = prefs({ channels: [{ channel: 'email', state: 'opted_out' }] });
    expect(evaluateConsent({ consent: 'operational', channel: 'email', preferences: p, nowMinuteOfDay: 600 }).decision).toBe('refuse');
  });
});
