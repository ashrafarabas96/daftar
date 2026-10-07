/**
 * @daftar/notifications — Phase 8 notification engine (PREPARED / NOT PROMOTED).
 *
 * Pure domain package: catalog, templates, renderer, consent gate, outbox
 * consumer, dispatcher, retry policy, status state machine, provider port and
 * two adapters (fake, official WhatsApp Cloud). No database, no network, no
 * clock, no second financial truth.
 */
export * from './types';
export * from './errors';
export * from './redaction';
export * from './catalog';
export * from './template-registry';
export * from './registry-laws';
export * from './render';
export * from './preferences';
export * from './retry';
export * from './status';
export * from './provider';
export * from './consumer';
export * from './dispatch';
export { FakeNotificationProvider, type FakeProviderOptions } from './providers/fake-provider';
export { WhatsAppCloudProvider, type WhatsAppCredentials, type HttpPort } from './providers/whatsapp-cloud';
