import { timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Parses `value` with `schema`, or throws a 400 listing the issues. */
export function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

/** Constant-time string comparison for shared tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
