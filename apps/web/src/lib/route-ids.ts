/**
 * Ids taken from the page URL (P3-S7 security review L-1). A route param or a
 * `?draft=` value is typed by whoever wrote the link, so it is checked against
 * the canonical UUID form before any API path is built from it; anything else
 * renders not-found and reaches no API.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the text is one UUID and nothing else. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
