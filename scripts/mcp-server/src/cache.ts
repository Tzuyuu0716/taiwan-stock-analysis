import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Minimal in-memory TTL cache. Company/ticker lists are multi-hundred-KB payloads
// that rarely change intraday, so we avoid re-fetching them on every tool call.

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

export async function getOrFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  const value = await fetcher();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

// Disk cache for data that never changes once written (closed trading days).
// Survives server restarts, so a second query — or a different ticker on the
// same days — skips the network entirely.
export const DISK_DIR = join(homedir(), ".cache", "taiwan-stock-mcp");

export async function getOrFetchDisk<T>(
  key: string,
  fetcher: () => Promise<T>,
  shouldPersist: (value: T) => boolean
): Promise<T> {
  const file = join(DISK_DIR, `${key.replace(/[^\w.-]/g, "_")}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    // miss (or corrupt file) -> fetch
  }
  const value = await fetcher();
  if (shouldPersist(value)) {
    await mkdir(DISK_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
  return value;
}

/**
 * Deletes cache files written more than maxAgeDays ago. Per-day lookups reach
 * back at most 40 weekdays (~2 months), so older files are never read again.
 * Run once at startup; ~100KB per trading day means no need for anything smarter.
 */
export async function pruneDiskCache(maxAgeDays: number): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of await readdir(DISK_DIR).catch(() => [] as string[])) {
    const file = join(DISK_DIR, name);
    const st = await stat(file).catch(() => null); // may vanish mid-scan (lock files)
    if (st && st.mtimeMs < cutoff) {
      await unlink(file).catch(() => {});
      removed++;
    }
  }
  return removed;
}
