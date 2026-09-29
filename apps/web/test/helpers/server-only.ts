/**
 * Test stand-in for the `server-only` marker package (see vitest.config.mts).
 * The real package throws when bundled for a client; a vitest run is neither
 * a client nor a React server bundle, so the marker is inert here.
 */
export {};
