import { Injectable, PipeTransform } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Zod validation pipe (§31: external input = untrusted; runtime schema validation
 * at the API boundary). Schemas are .strict(): unexpected fields are rejected
 * (mass-assignment defense §94).
 *
 * Applied via @UsePipes it runs for EVERY handler parameter (including custom
 * decorators like @Principal()), so it validates only the request body and
 * passes other parameters through untouched.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    return this.schema.parse(value);
  }
}

export interface Pagination {
  limit: number;
  cursor?: string;
}

/** limit 1..100 (oversized rejected), opaque cursor (§96). */
export function parsePagination(query: Record<string, unknown>): Pagination {
  const rawLimit = Number(query.limit ?? 20);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw new Error('INVALID_PAGINATION');
  }
  const cursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : undefined;
  return { limit: rawLimit, ...(cursor ? { cursor } : {}) };
}

export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? cursorOf(last) : null,
  };
}
