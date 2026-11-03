import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DISK_DIR } from "./cache.js";

// Thin fetch wrapper: enforces a timeout and surfaces failures with the
// requesting URL attached, so tool errors are actionable instead of "fetch failed".

const DEFAULT_TIMEOUT_MS = 15_000;

export class UpstreamError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

// TWSE bans IPs that exceed ~3 requests / 5s, so requests to it are queued with a
// fixed gap. The next free slot lives in a file so separate server processes
// (e.g. Claude Desktop and Claude Code running at once) share one queue.
const MIN_GAP_MS: Record<string, number> = { "www.twse.com.tw": 2_000 };
const LOCK_STALE_MS = 5_000; // a crashed holder's lock is ignored after this
const memorySlot = new Map<string, number>(); // fallback if the cache dir is unusable
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reserves the next slot for host across processes; returns when the request may start. */
async function reserveSharedSlot(host: string, gap: number): Promise<number> {
  await mkdir(DISK_DIR, { recursive: true });
  const base = join(DISK_DIR, `throttle-${host}`);
  const lock = `${base}.lock`;
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) await unlink(lock).catch(() => {});
      else await sleep(20);
    }
  }
  try {
    const prev = Number(await readFile(`${base}.next`, "utf8").catch(() => "0")) || 0;
    const slot = Math.max(Date.now(), prev);
    await writeFile(`${base}.next`, String(slot + gap));
    return slot;
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function throttle(url: string): Promise<void> {
  const host = new URL(url).host;
  const gap = MIN_GAP_MS[host];
  if (!gap) return;
  const slot = await reserveSharedSlot(host, gap).catch(() => {
    const s = Math.max(Date.now(), memorySlot.get(host) ?? 0);
    memorySlot.set(host, s + gap);
    return s;
  });
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Extra attempts after the first failure. */
  retries?: number;
  /** Epoch ms; no attempt starts after it and each attempt's timeout is clipped to it. */
  deadline?: number;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 0, deadline = Infinity } = opts;
  for (let attempt = 0; ; attempt++) {
    await throttle(url);
    const remaining = deadline - Date.now();
    if (remaining < 1_000) throw new UpstreamError("Time budget exhausted", url);
    try {
      return await fetchOnce<T>(url, Math.min(timeoutMs, remaining));
    } catch (err) {
      if (attempt >= retries) throw err;
    }
  }
}

async function fetchOnce<T>(url: string, timeoutMs: number): Promise<T> {
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
  const entries = Object.entries(row).map(([k, v]) => [normalize(k), v] as const);
  // Exact first: "dealers-difference" is a substring of "foreigndealers-difference",
  // which comes earlier in TPEx's key order.
  return (
    entries.find(([nk]) => targets.includes(nk))?.[1] ??
    entries.find(([nk]) => targets.some((t) => nk.includes(t)))?.[1]
  );
}
