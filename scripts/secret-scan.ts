/**
 * The release's raw-credential content scan, shared by the release export
 * (`scripts/export-release.ts`) and the Phase 1 release gate
 * (`scripts/phase1-release-gate.ts`).
 *
 * It reads EVERY file it is handed that is not binary — scripts, templates,
 * config of any spelling, `.github/**`, `tests/**`, `docs/**`, the root files
 * — with no extension list and no path exemption (review L-4): a key in a
 * `.sh`, a `.toml` or a `.sql.template` ships as surely as one in a `.ts`.
 * A file is binary when its first 8000 bytes hold a NUL byte, git's own rule.
 *
 * Raw key material (a PEM private key, an argon2id hash) is refused in every
 * file. The dev/test credential key's constant NAME is refused too when the
 * caller asks (the export does), except in the exact files below, each of
 * which defines, guards or documents it.
 */

/** A PEM private key or an argon2id password hash. */
export const RAW_CREDENTIAL = /argon2id\$[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** The dev/test credential key's constant (apps/api/src/modules/delivery/credential-protector.ts). */
export const DEV_KEY_NAME = /DEV_TEST_KEY(?!\w)/;

/** Exact paths allowed to NAME the dev/test key, each with its reason. Never a pattern; never raw key material. */
export const DEV_KEY_NAME_ALLOWED: ReadonlyMap<string, string> = new Map([
  ['apps/api/src/modules/delivery/credential-protector.ts', 'defines the dev/test key and refuses it when NODE_ENV=production (§24)'],
  ['scripts/secret-scan.ts', 'this scanner: the rule that refuses the name elsewhere spells it'],
  ['scripts/static-guards.ts', 'the static guard that forbids the dev/test key outside an explicit non-production branch'],
  ['tests/integration/runtime-isolation.test.ts', 'asserts the production refusal message, which names the key (§24)'],
  ['docs/PHASE_1_CLOSURE_TRACKER.md', 'records the §24 closure, which names the key'],
]);

/** Git's rule: a NUL byte in the first 8000 bytes makes a file binary. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/** What `rel` holds that must not ship, or null. */
export function credentialFinding(rel: string, content: Buffer, rules: { devKeyName: boolean }): string | null {
  if (isBinary(content)) return null;
  const text = content.toString('utf8');
  if (RAW_CREDENTIAL.test(text)) return 'raw key material (a private key or an argon2id hash)';
  if (rules.devKeyName && DEV_KEY_NAME.test(text) && !DEV_KEY_NAME_ALLOWED.has(rel)) return 'the dev/test credential key constant';
  return null;
}
