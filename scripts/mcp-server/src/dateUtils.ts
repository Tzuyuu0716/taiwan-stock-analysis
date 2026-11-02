// Date helpers. TWSE/TPEx APIs mix ROC-era date strings ("115/07/13" or "1150713")
// with western-year query params ("20260713"). All conversions live here.

const ROC_OFFSET = 1911;

export function parseIsoDate(input: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!m) {
    throw new Error(`Invalid date "${input}", expected YYYY-MM-DD`);
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date "${input}"`);
  }
  return d;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** "115/07/13" or "1150713" (ROC year, no separators) -> "2026-07-13" */
export function rocToIso(rocDate: string): string {
  const digitsOnly = rocDate.replace(/\D/g, "");
  if (digitsOnly.length !== 7) {
    throw new Error(`Unexpected ROC date format: "${rocDate}"`);
  }
  const rocYear = Number(digitsOnly.slice(0, 3));
  const month = digitsOnly.slice(3, 5);
  const day = digitsOnly.slice(5, 7);
  const year = rocYear + ROC_OFFSET;
  return `${year}-${month}-${day}`;
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** First-of-month dates covering [start, end], inclusive, one per calendar month. */
export function enumerateMonths(start: Date, end: Date): Date[] {
  const months: Date[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= last.getTime()) {
    months.push(cursor);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

/**
 * Weekday dates in [start, end], most recent first, capped at maxDays entries.
 * Used for per-day endpoints (T86, margin) where each call costs one HTTP request,
 * so we bound the fan-out instead of silently issuing hundreds of requests.
 */
export function enumerateWeekdaysDesc(start: Date, end: Date, maxDays: number): Date[] {
  const out: Date[] = [];
  let cursor = new Date(end.getTime());
  while (cursor.getTime() >= start.getTime() && out.length < maxDays) {
    if (!isWeekend(cursor)) {
      out.push(new Date(cursor.getTime()));
    }
    cursor = addDays(cursor, -1);
  }
  return out;
}

export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
