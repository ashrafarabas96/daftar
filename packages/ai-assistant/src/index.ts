/**
 * DAFTAR Phase 12 — AI Assistant decision core.
 *
 * STATUS: PREPARED / NOT PROMOTED (master directive PART 9). Nothing here is wired into a running
 * surface, no migration number is allocated, and no financial effect passes through this package.
 *
 * The whole design in one sentence: the assistant is an input device for the existing manual path,
 * not a second path. See P12-S0-ARCHITECTURE-CONTRACT.md.
 *
 * This package contains only PURE decision logic — no database, no HTTP, no model provider. The
 * surfaces that will call it are listed in the contract and are owned by their phases.
 */

export * from './refusals';
export * from './authority';
export * from './tool-registry';
export * from './draft-state';
export * from './preview-digest';
export * from './injection';
export * from './provider-boundary';
