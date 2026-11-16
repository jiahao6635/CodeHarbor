import type { FastifyError } from 'fastify';
import { CodeupError } from '../codeup.js';
import { IndexError } from '../indexer.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function fail(status: number, code: string): never {
  throw new HttpError(status, code);
}

export type ErrorReply = { status: number; code: string; log?: boolean };

const FASTIFY_CODES: Record<string, ErrorReply> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'BODY_TOO_LARGE' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'INVALID_JSON' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'INVALID_JSON' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'INVALID_REQUEST' },
  FST_ERR_REQ_INVALID_CONTENT_LENGTH: { status: 400, code: 'INVALID_REQUEST' },
};

/** Maps any failure to a fixed public error code; nothing from the error itself reaches the client. */
export function toErrorReply(error: unknown): ErrorReply {
  if (error instanceof HttpError) return { status: error.status, code: error.code };
  if (error instanceof IndexError) {
    const unavailable = error.code === 'AUTH_BUSY' || error.code === 'AUTH_UNAVAILABLE';
    return unavailable ? { status: 503, code: 'AUTHORIZATION_UNAVAILABLE' } : { status: 400, code: 'INVALID_REQUEST' };
  }
  if (error instanceof CodeupError) {
    if (error.kind === 'invalid_credential') return { status: 401, code: 'INVALID_CREDENTIAL' };
    if (error.kind === 'forbidden' || error.kind === 'not_found') return { status: 404, code: 'NOT_FOUND' };
    return { status: 503, code: 'CODEUP_UNAVAILABLE' };
  }
  const fastifyCode = (error as Partial<FastifyError> | null)?.code;
  if (typeof fastifyCode === 'string' && FASTIFY_CODES[fastifyCode]) return FASTIFY_CODES[fastifyCode];
  return { status: 500, code: 'INTERNAL_ERROR', log: true };
}
