import { z } from 'zod';
import { byteLength, charCount, hasForbiddenControls, isWellFormed } from '../utils/text';

interface TextOptions {
  maxChars: number;
  maxBytes?: number;
  multiline: boolean;
  description?: string;
}

/**
 * Validated free text: code-point length cap, optional UTF-8 byte cap, no
 * lone surrogates, no control characters (TAB/LF/CR allowed when multiline),
 * and not blank.
 */
export function text(opts: TextOptions) {
  const limit = `Max ${opts.maxChars} characters${opts.maxBytes ? ` and ${opts.maxBytes} UTF-8 bytes` : ''}.`;
  return z
    .string()
    .superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Must not be blank.' });
      return;
    }
    if (!isWellFormed(value)) {
      ctx.addIssue({ code: 'custom', message: 'Contains invalid Unicode (lone surrogate).' });
      return;
    }
    if (hasForbiddenControls(value, opts.multiline)) {
      ctx.addIssue({
        code: 'custom',
        message: opts.multiline
          ? 'Contains control characters. Only tab, newline and carriage return are allowed.'
          : 'Contains control characters or line breaks, which are not allowed in this field.',
      });
      return;
    }
    if (charCount(value) > opts.maxChars) {
      ctx.addIssue({ code: 'custom', message: `Must be at most ${opts.maxChars} characters.` });
      return;
    }
    if (opts.maxBytes !== undefined && byteLength(value) > opts.maxBytes) {
      ctx.addIssue({ code: 'custom', message: `Must be at most ${opts.maxBytes} bytes of UTF-8.` });
    }
  })
    .describe(opts.description ? `${opts.description} ${limit}` : limit);
}

export const shortLabel = (description: string, maxChars = 150) =>
  text({ maxChars, multiline: false, description });

export const freeText = (description: string, maxChars = 2000) =>
  text({ maxChars, multiline: true, description });

/** Client-chosen idempotency identifier. */
export const idempotencyKey = (description: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'Use 1-128 characters from A-Z a-z 0-9 . _ : -')
    .describe(description);

export const languageTag = z
  .string()
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,5}$/, 'Must be a BCP-47 language tag, e.g. "en" or "fr-CA".')
  .describe('Optional BCP-47 language tag. Not required; the service does not force a language.');
