import 'server-only';

/** Server-side base URL of the merchant API. Never exposed to the browser. */
export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
