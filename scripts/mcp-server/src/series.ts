// Shared fetch loops for historical series (TWSE and TPEx alike).
//
// Upstream answers one trading day (whole market) or one month (one ticker) per
// call. These loops add what every caller needs: disk cache for final data, a
// time budget below the MCP client's ~60s timeout, and partial results — a
// failed day/month is reported in limitationNote instead of failing the call.
import { getOrFetchDisk } from "./cache.js";
import { addDays, enumerateMonths, enumerateWeekdaysDesc, parseIsoDate, toIsoDate, todayUtc, toYyyymmdd } from "./dateUtils.js";
import type { DailyPriceRow } from "./types.js";

const BUDGET_MS = 45_000; // most MCP clients drop a call at ~60s
const MAX_CONSECUTIVE_FAILURES = 3; // likely rate-limited; stop instead of hammering
const MAX_DAILY_LOOKBACK = 40; // weekdays scanned at most per call
const BUDGET_NOTE = `已達 ${BUDGET_MS / 1000} 秒時間上限，提前停止。`;

export interface DailySeries<R> {
  rows: R[];
  limitationNote?: string;
}

/** ticker -> selected columns of one day's whole-market table; null = no session that day. */
export type DaySnapshot = Record<string, string[]> | null;

export function toSnapshot(data: string[][], cols: number[]): Record<string, string[]> {
  return Object.fromEntries(data.map((r) => [r[0].trim(), cols.map((i) => r[i])]));
}

function taipeiTodayYmd(): string {
  return toYyyymmdd(new Date(Date.now() + 8 * 60 * 60 * 1000));
}

/**
 * Published sessions are final -> disk cache. "No data" is persisted only for
 * past days (holidays); today's may simply not be published yet.
 */
export function cacheDay(key: string, day: Date, fetcher: () => Promise<DaySnapshot>): Promise<DaySnapshot> {
  const ymd = toYyyymmdd(day);
  return getOrFetchDisk(`${key}-${ymd}`, fetcher, (snap) => snap !== null || ymd < taipeiTodayYmd());
}

/** Past months are final -> disk cache; the current month is refetched. */
export function cacheMonth<T>(key: string, monthStart: Date, fetcher: () => Promise<T>): Promise<T> {
  const ym = toYyyymmdd(monthStart).slice(0, 6);
  return getOrFetchDisk(`${key}-${ym}`, fetcher, () => ym < taipeiTodayYmd().slice(0, 6));
}

function buildNote(notes: string[], retryHint: string): string | undefined {
  if (notes.length) notes.push(retryHint);
  return notes.length ? notes.join(" ") : undefined;
}

/** Walks weekdays newest-first until `days` sessions containing `ticker` are found. */
export async function collectDaily<R extends { date: string }>(
  source: string,
  fetchDay: (day: Date, deadline: number) => Promise<DaySnapshot>,
  ticker: string,
  days: number,
  toRow: (date: string, v: string[]) => R
): Promise<DailySeries<R>> {
  const deadline = Date.now() + BUDGET_MS;
  const end = todayUtc();
  const start = addDays(end, -Math.max(days, 1) * 2); // widen window to absorb holidays
  const rows: R[] = [];
  const failed: string[] = [];
  let stopReason = "";
  let streak = 0;

  for (const day of enumerateWeekdaysDesc(start, end, MAX_DAILY_LOOKBACK)) {
    if (rows.length >= days) break;
    if (Date.now() >= deadline) {
      stopReason = BUDGET_NOTE;
      break;
    }
    try {
      const v = (await fetchDay(day, deadline))?.[ticker];
      streak = 0;
      if (v) rows.push(toRow(toIsoDate(day), v));
    } catch {
      if (Date.now() >= deadline - 1_000) {
        stopReason = BUDGET_NOTE;
        break;
      }
      failed.push(toIsoDate(day));
      if (++streak >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `連續 ${streak} 天請求失敗（${source}可能限流），提前停止。`;
        break;
      }
    }
  }

  const notes: string[] = [];
  if (rows.length < days) notes.push(`要求 ${days} 個交易日，實得 ${rows.length} 個。`);
  if (failed.length) notes.push(`以下日期抓取失敗（可能是交易日或假日）：${failed.join(", ")}。`);
  if (stopReason) notes.push(stopReason);
  return {
    rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
    limitationNote: buildNote(notes, "已抓到的收盤日資料已快取，稍後再查一次即可補齊。"),
  };
}

/** One call per calendar month, newest first so a partial result is the most recent stretch. */
export async function collectMonthly(
  source: string,
  fetchMonth: (monthStart: Date, deadline: number) => Promise<DailyPriceRow[]>,
  startIso: string,
  endIso: string
): Promise<DailySeries<DailyPriceRow>> {
  const deadline = Date.now() + BUDGET_MS;
  const label = (m: Date) => toIsoDate(m).slice(0, 7);
  const months = enumerateMonths(parseIsoDate(startIso), parseIsoDate(endIso)).reverse();
  const rows: DailyPriceRow[] = [];
  const failed: string[] = [];
  let stopReason = "";
  let streak = 0;

  for (const monthStart of months) {
    const budgetStop = `${BUDGET_NOTE}未抓取：${label(months.at(-1)!)} 至 ${label(monthStart)}。`;
    if (Date.now() >= deadline) {
      stopReason = budgetStop;
      break;
    }
    try {
      const month = await fetchMonth(monthStart, deadline);
      streak = 0;
      rows.push(...month.filter((r) => r.date >= startIso && r.date <= endIso));
    } catch {
      if (Date.now() >= deadline - 1_000) {
        stopReason = budgetStop;
        break;
      }
      failed.push(label(monthStart));
      if (++streak >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `連續 ${streak} 個月請求失敗（${source}可能限流），提前停止。`;
        break;
      }
    }
  }

  const notes: string[] = [];
  if (failed.length) notes.push(`以下月份抓取失敗：${failed.join(", ")}。`);
  if (stopReason) notes.push(stopReason);
  return {
    rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
    limitationNote: buildNote(notes, "已抓到的月份已快取，稍後再查一次即可補齊。"),
  };
}
