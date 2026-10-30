export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** UTC ISO-8601 with millisecond precision; lexical order equals time order. */
export function iso(date: Date): string {
  return date.toISOString();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** Start of the fixed window containing `date`. */
export function windowStart(date: Date, windowMs: number): number {
  return Math.floor(date.getTime() / windowMs) * windowMs;
}
