import { z } from 'zod';
import { fail } from './errors.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** Non-empty printable string without control characters, bounded in length. */
export const text = (max = 256) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARACTERS.test(value));

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const userId = z.string().regex(/^[A-Za-z0-9_.@-]{1,128}$/);
export const keyPrefix = z.string().regex(/^ch_[A-Za-z0-9_-]{8}$/);
export const scope = z.enum(['read', 'write']);
export const expiresIn = z
  .number()
  .int()
  .min(60)
  .max(90 * 86_400);
export const positivePage = z.coerce.number().int().min(1);

/** Query strings coerce to one value; repeated parameters are rejected. */
export const singleQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (Array.isArray(value) ? Symbol('repeated') : value), schema);

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_ARGUMENT');
  const result = schema.safeParse(body);
  if (!result.success) fail(400, 'INVALID_ARGUMENT');
  return result.data;
}

export function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query ?? {});
  if (!result.success) fail(400, 'INVALID_ARGUMENT');
  return result.data;
}

/** Path parameters that do not match their shape are indistinguishable from unknown resources. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) fail(404, 'NOT_FOUND');
  return result.data;
}
