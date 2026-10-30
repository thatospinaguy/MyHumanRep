const encoder = new TextEncoder();

/** Unicode code point count (not UTF-16 units). */
export function charCount(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** True when the string has no lone surrogates. */
export function isWellFormed(value: string): boolean {
  const s = value as string & { isWellFormed?: () => boolean };
  if (typeof s.isWellFormed === 'function') return s.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

// C0 controls except TAB/LF/CR, DEL, and C1 controls.
const MULTILINE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Single-line fields additionally forbid TAB/LF/CR and line/paragraph separators.
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

export function hasForbiddenControls(value: string, multiline: boolean): boolean {
  return (multiline ? MULTILINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN).test(value);
}

/** Bidirectional formatting characters that can visually reorder text. */
export const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
