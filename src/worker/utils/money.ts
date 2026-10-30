// ISO-4217 minor-unit exponents that differ from the default of 2.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function currencyExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/**
 * Converts a major-unit amount to integer minor units. Returns null when the
 * amount has more decimal places than the currency allows.
 */
export function toMinorUnits(amount: number, currency: string): number | null {
  const factor = 10 ** currencyExponent(currency);
  const minor = Math.round(amount * factor);
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  if (Math.abs(minor / factor - amount) > 1e-9 * Math.max(1, amount)) return null;
  return minor;
}

export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}
