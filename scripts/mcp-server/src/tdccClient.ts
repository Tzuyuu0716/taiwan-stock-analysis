// TDCC (集保結算所) 集保戶股權分散表 client. Covers 上市, 上櫃 and 興櫃 alike.
//
// Two sources, verified empirically (see README):
// - Open data CSV https://opendata.tdcc.com.tw/getOD.ashx?id=1-5 — whole market,
//   but ONLY the latest week (no date parameter). Levels 1-15 are holding tiers,
//   16 = 差異數調整, 17 = 合計. Ticker codes are right-padded with spaces. The CSV
//   carries tier numbers only, no share ranges.
// - Web form https://www.tdcc.com.tw/portal/zh/smWeb/qryStock — ~1 year of weekly
//   dates (listed in the scaDate <select>), no captcha, but a single-use
//   SYNCHRONIZER_TOKEN bound to a session cookie, so every query is GET (token +
//   cookie) then POST. Response is UTF-8 HTML whose rows carry the official tier
//   share ranges ("400,001-600,000", "1,000,001以上"); the 合計 row's level number
//   varies (16 or 17 depending on whether a 差異數調整 row exists), so it is
//   identified by label, never by position.
// Big-holder tiers are derived from those official range labels, not hardcoded.
import { getOrFetch } from "./cache.js";
import { UpstreamError, parseTwNumber } from "./httpClient.js";
import type { DistributionTier, DistributionWeek } from "./types.js";

const OPEN_DATA_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5";
const QUERY_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";
const OPEN_DATA_TTL_MS = 6 * 60 * 60 * 1000; // published weekly
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // past weeks never change
const TIMEOUT_MS = 20_000;
const SCRAPE_DELAY_MS = 500; // be polite to a web form that is not an API
/** 大戶 = 持股 400 張（400,000 股）以上；以集保級距下限判斷落在哪些級距。 */
export const BIG_HOLDER_MIN_SHARES = 400_000;

async function fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status} ${res.statusText}`, url);
    return res;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(`Request failed: ${err instanceof Error ? err.message : String(err)}`, url);
  }
}

function compactToIso(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** Lower bound (shares) of a tier label like "400,001-600,000" or "1,000,001以上"; null for non-tier rows. */
export function tierLowerBound(range: string): number | null {
  const m = /^\s*([\d,]+)/.exec(range);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Builds one week from tier rows (levels 1-15 with ranges) plus totals. */
export function summarizeWeek(
  date: string,
  tiers: DistributionTier[],
  totalHolders: number | null,
  totalShares: number | null
): DistributionWeek {
  const labelled = tiers.every((t) => t.range !== null);
  const big = tiers.filter((t) => (tierLowerBound(t.range ?? "") ?? 0) > BIG_HOLDER_MIN_SHARES);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  return {
    date,
    totalHolders,
    totalShares,
    bigHolderLevels: labelled ? big.map((t) => t.level) : [],
    bigHolderCount: labelled ? sum(big.map((t) => t.holders)) : null,
    bigHolderPct: labelled ? Math.round(sum(big.map((t) => t.pct)) * 100) / 100 : null,
    tiers,
  };
}

// ---------- open data (latest week) ----------

interface OpenDataRow {
  level: number;
  holders: number | null;
  shares: number | null;
  pct: number | null;
}

async function fetchOpenData(): Promise<{ date: string; byTicker: Map<string, OpenDataRow[]> }> {
  return getOrFetch("tdcc:openData", OPEN_DATA_TTL_MS, async () => {
    const text = (await (await fetchRaw(OPEN_DATA_URL)).text()).replace(/^﻿/, "");
    const byTicker = new Map<string, OpenDataRow[]>();
    let date = "";
    for (const line of text.split(/\r?\n/).slice(1)) {
      const c = line.split(",");
      if (c.length < 6) continue;
      date = c[0].trim();
      const ticker = c[1].trim();
      const rows = byTicker.get(ticker) ?? [];
      rows.push({
        level: Number(c[2]),
        holders: parseTwNumber(c[3]),
        shares: parseTwNumber(c[4]),
        pct: parseTwNumber(c[5]),
      });
      byTicker.set(ticker, rows);
    }
    if (!date) throw new UpstreamError("集保開放資料內容為空或格式改變", OPEN_DATA_URL);
    return { date, byTicker };
  });
}

// ---------- web form (history + official tier labels) ----------

interface FormSession {
  cookie: string;
  token: string;
  firDate: string;
  dates: string[]; // yyyymmdd, newest first
}

async function openFormSession(): Promise<FormSession> {
  const res = await fetchRaw(QUERY_URL);
  const html = await res.text();
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const token = /name="SYNCHRONIZER_TOKEN" value="([^"]+)"/.exec(html)?.[1];
  const firDate = /name="firDate" value="(\d{8})"/.exec(html)?.[1];
  const dates = [...html.matchAll(/<option[^>]*value="(\d{8})"/g)].map((m) => m[1]);
  if (!token || !firDate || dates.length === 0) {
    throw new UpstreamError("集保股權分散表查詢頁格式改變（找不到 token 或日期選單）", QUERY_URL);
  }
  return { cookie, token, firDate, dates };
}

interface ScrapedRow {
  level: number;
  range: string;
  holders: number | null;
  shares: number | null;
  pct: number | null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

/** Parses the result table; returns [] when TDCC answers 查無資料. */
export function parseQueryHtml(html: string): ScrapedRow[] {
  const rows: ScrapedRow[] = [];
  for (const tr of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => stripTags(m[1]));
    if (cells.length !== 5 || !/^\d+$/.test(cells[0])) continue;
    rows.push({
      level: Number(cells[0]),
      range: cells[1],
      holders: parseTwNumber(cells[2]),
      shares: parseTwNumber(cells[3]),
      pct: parseTwNumber(cells[4]),
    });
  }
  return rows;
}

/** One GET+POST round trip (token is single-use). */
async function scrapeWeek(ticker: string, date: string): Promise<ScrapedRow[]> {
  return getOrFetch(`tdcc:week:${ticker}:${date}`, HISTORY_TTL_MS, async () => {
    const s = await openFormSession();
    const body = new URLSearchParams({
      SYNCHRONIZER_TOKEN: s.token,
      SYNCHRONIZER_URI: "/portal/zh/smWeb/qryStock",
      method: "submit",
      firDate: s.firDate,
      scaDate: date,
      sqlMethod: "StockNo",
      stockNo: ticker,
      stockName: "",
    });
    const res = await fetchRaw(QUERY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: s.cookie },
      body,
    });
    return parseQueryHtml(await res.text());
  });
}

function weekFromScrape(date: string, rows: ScrapedRow[]): DistributionWeek {
  const tiers = rows
    .filter((r) => tierLowerBound(r.range) !== null)
    .map(({ level, range, holders, shares, pct }) => ({ level, range, holders, shares, pct }));
  const total = rows.find((r) => r.range.replace(/\s/g, "").includes("合計"));
  return summarizeWeek(compactToIso(date), tiers, total?.holders ?? null, total?.shares ?? null);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DistributionResult {
  weeks: DistributionWeek[];
  limitationNote?: string;
}

/**
 * Latest week from open data; older weeks scraped from the web form. If the
 * scrape fails, returns what was collected plus a limitationNote rather than
 * failing the whole call.
 */
export async function getShareholdingDistribution(ticker: string, weeks: number): Promise<DistributionResult> {
  const open = await fetchOpenData();
  const openRows = open.byTicker.get(ticker) ?? [];
  const notes: string[] = [];
  const result: DistributionWeek[] = [];

  let scrapeOk = true;
  let labels = new Map<number, string>();
  let historyDates: string[] = [];
  try {
    const session = await openFormSession();
    historyDates = session.dates.filter((d) => d !== open.date).slice(0, weeks - 1);
    // Tier labels come from TDCC's own table; any week works, the latest is cheapest to reason about.
    const labelRows = await scrapeWeek(ticker, session.dates[0]);
    labels = new Map(labelRows.filter((r) => tierLowerBound(r.range) !== null).map((r) => [r.level, r.range]));
  } catch (err) {
    scrapeOk = false;
    notes.push(`集保網頁查詢失敗（${err instanceof Error ? err.message : String(err)}），無法取得歷史週資料與官方級距定義。`);
  }

  if (openRows.length > 0) {
    const tiers = openRows
      .filter((r) => r.level >= 1 && r.level <= 15)
      .map((r) => ({ ...r, range: labels.get(r.level) ?? null }));
    const total = openRows.find((r) => r.level === 17);
    result.push(summarizeWeek(compactToIso(open.date), tiers, total?.holders ?? null, total?.shares ?? null));
    if (labels.size === 0) notes.push("缺少官方級距定義，bigHolderPct 無法計算。");
  }

  if (scrapeOk) {
    for (const date of historyDates) {
      try {
        await sleep(SCRAPE_DELAY_MS);
        // ponytail: one retry for TDCC's occasional slow responses; add backoff if it keeps timing out
        const rows = await scrapeWeek(ticker, date).catch(() => sleep(SCRAPE_DELAY_MS * 4).then(() => scrapeWeek(ticker, date)));
        if (rows.length > 0) result.push(weekFromScrape(date, rows));
      } catch (err) {
        notes.push(
          `集保網頁查詢 ${date} 失敗（${err instanceof Error ? err.message : String(err)}），僅回傳已取得的週次。`
        );
        break;
      }
    }
  }

  if (weeks > 1 && result.length < weeks) {
    notes.push(
      "集保開放資料（opendata.tdcc.com.tw id=1-5）僅提供最新一週，歷史週次需透過集保網頁表單逐週查詢（約一年內），" +
        `本次要求 ${weeks} 週、實得 ${result.length} 週。`
    );
  }
  return { weeks: result, limitationNote: notes.length ? notes.join(" ") : undefined };
}
