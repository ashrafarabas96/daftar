import 'server-only';

/** Server-side base URL of the PLATFORM API. Admin never talks to merchant routes. */
export const API_URL = process.env.PLATFORM_API_URL ?? process.env.API_URL ?? 'http://localhost:3000';
