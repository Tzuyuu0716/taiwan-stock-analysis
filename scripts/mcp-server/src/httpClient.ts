// Thin fetch wrapper: enforces a timeout and surfaces failures with the
// requesting URL attached, so tool errors are actionable instead of "fetch failed".

const DEFAULT_TIMEOUT_MS = 15_000;

export class UpstreamError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new UpstreamError(`HTTP ${res.status} ${res.statusText}`, url);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UpstreamError(
        `Response was not valid JSON (first 200 chars: ${text.slice(0, 200)})`,
        url
      );
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new UpstreamError(`Request timed out after ${timeoutMs}ms`, url);
    }
    throw new UpstreamError(
      `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      url
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a Taiwan-formatted numeric string ("1,234", "", "-", " ") -> number | null. */
export function parseTwNumber(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "－") return null;
  const cleaned = trimmed.replace(/,/g, "").replace(/^\+/, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

/**
 * Looks up a value in a loosely-keyed record by matching normalized (whitespace-
 * stripped, lowercased) key patterns. Some TPEx OpenAPI endpoints ship JSON keys
 * with inconsistent spacing/typos (e.g. "Dealers-TotalBuy" vs "Dealers -TotalSell"),
 * so exact-key access is fragile; this tolerates that.
 */
export function pickByPattern(
  row: Record<string, string>,
  patterns: string[]
): string | undefined {
  const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const targets = patterns.map(normalize);
  for (const [key, value] of Object.entries(row)) {
    const nk = normalize(key);
    if (targets.some((t) => nk === t || nk.includes(t))) {
      return value;
    }
  }
  return undefined;
}
