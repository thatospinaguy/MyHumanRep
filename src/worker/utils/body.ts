import { ApiError } from './http-errors';

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Reads and parses a JSON request body with a hard byte cap. The cap is
 * enforced while streaming, so a missing or false Content-Length cannot be
 * used to push an oversized body into memory.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (mediaType(request.headers.get('content-type')) !== 'application/json') {
    throw new ApiError('unsupported_media_type', 'Request body must be JSON (Content-Type: application/json).', {
      reason: 'content_type_must_be_json',
    });
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw tooLarge(maxBytes);
  }
  const text = await readTextCapped(request, maxBytes);
  if (text.trim() === '') {
    throw new ApiError('invalid_request', 'Request body is empty.', { reason: 'empty_body' });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('invalid_request', 'Request body is not valid JSON.', { reason: 'malformed_json' });
  }
}

export async function readTextCapped(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    throw new ApiError('invalid_request', 'Request body is not valid UTF-8.', { reason: 'invalid_utf8' });
  }
}

function tooLarge(maxBytes: number): ApiError {
  return new ApiError('payload_too_large', `Request body exceeds ${maxBytes} bytes.`, {
    reason: 'body_too_large',
    max_bytes: maxBytes,
  });
}
