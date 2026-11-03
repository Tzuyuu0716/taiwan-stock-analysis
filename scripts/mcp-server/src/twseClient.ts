// TWSE (上市) data client.
//
// Historical per-ticker series (daily price / institutional flows / margin) only
// exist on the classic `www.twse.com.tw/rwd/zh/...` endpoints, which answer one
// month (price) or one trading day (flows/margin) per call. The newer
// `openapi.twse.com.tw` endpoints only ever return the latest snapshot for the
// whole market, so they're used here just for the static company-profile list.
import { getOrFetch, getOrFetchDisk } from "./cache.js";
import { UpstreamError, fetchJson, parseTwNumber } from "./httpClient.js";
import {
  addDays,
  enumerateMonths,
  enumerateWeekdaysDesc,
  parseIsoDate,
  rocToIso,
  toIsoDate,
  todayUtc,
  toYyyymmdd,
} from "./dateUtils.js";
import type {
  CompanyProfile,
  DailyPriceRow,
  InstitutionalFlowRow,
  MarginTradingRow,
  TickerSearchHit,
} from "./types.js";

const RWD_BASE = "https://www.twse.com.tw/rwd/zh";
const OPEN_BASE = "https://openapi.twse.com.tw/v1";
const COMPANY_LIST_TTL_MS = 12 * 60 * 60 * 1000; // 12h: static reference data

interface RawCompany {
  公司代號: string;
  公司名稱: string;
  公司簡稱: string;
  上市日期: string;
  成立日期: string;
  產業別: string;
  董事長: string;
  總經理: string;
  實收資本額: string;
}

async function fetchCompanyList(): Promise<RawCompany[]> {
  return getOrFetch("twse:companyList", COMPANY_LIST_TTL_MS, () =>
    fetchJson<RawCompany[]>(`${OPEN_BASE}/opendata/t187ap03_L`)
  );
}

function isoFromCompactDate(s: string | undefined): string | null {
  if (!s || s.trim() === "") return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

// ETFs (0050 etc.) are not in the company list; TWSE publishes them separately.
interface RawEtf {
  基金代號: string;
  基金簡稱: string;
  基金中文名稱: string;
  基金類型: string;
  成立日期: string;
  上市日期: string;
}

async function fetchEtfList(): Promise<RawEtf[]> {
  return getOrFetch("twse:etfList", COMPANY_LIST_TTL_MS, () =>
    fetchJson<RawEtf[]>(`${OPEN_BASE}/opendata/t187ap47_L`)
  );
}

function rocOrNull(s: string | undefined): string | null {
  return s && s.replace(/\D/g, "").length === 7 ? rocToIso(s) : null;
}

export async function isTwseTicker(ticker: string): Promise<boolean> {
  const [companies, etfs] = await Promise.all([fetchCompanyList(), fetchEtfList()]);
  return companies.some((c) => c.公司代號 === ticker) || etfs.some((e) => e.基金代號 === ticker);
}

export async function getCompanyProfile(ticker: string): Promise<CompanyProfile | null> {
  const list = await fetchCompanyList();
  const row = list.find((c) => c.公司代號 === ticker);
  if (!row) {
    const etf = (await fetchEtfList()).find((e) => e.基金代號 === ticker);
    if (!etf) return null;
    return {
      ticker: etf.基金代號,
      name: etf.基金中文名稱,
      shortName: etf.基金簡稱 || null,
      marketType: "TWSE",
      listedDate: rocOrNull(etf.上市日期),
      incorporationDate: rocOrNull(etf.成立日期),
      industry: `ETF（${etf.基金類型}）`,
      chairman: null,
      generalManager: null,
      capital: null,
    };
  }
  return {
    ticker: row.公司代號,
    name: row.公司名稱,
    shortName: row.公司簡稱 || null,
    marketType: "TWSE",
    listedDate: isoFromCompactDate(row.上市日期),
    incorporationDate: isoFromCompactDate(row.成立日期),
    industry: row.產業別 || null,
    chairman: row.董事長 || null,
    generalManager: row.總經理 || null,
    capital: parseTwNumber(row.實收資本額),
  };
}

export async function searchByName(query: string): Promise<TickerSearchHit[]> {
  const [companies, etfs] = await Promise.all([fetchCompanyList(), fetchEtfList()]);
  const q = query.trim();
  return [
    ...companies
      .filter((c) => c.公司名稱.includes(q) || (c.公司簡稱 ?? "").includes(q))
      .map((c) => ({ ticker: c.公司代號, name: c.公司簡稱 || c.公司名稱, marketType: "TWSE" as const })),
    ...etfs
      .filter((e) => e.基金中文名稱.includes(q) || e.基金簡稱.includes(q))
      .map((e) => ({ ticker: e.基金代號, name: e.基金簡稱, marketType: "TWSE" as const })),
  ];
}

const BUDGET_MS = 45_000; // most MCP clients drop a call at ~60s
const MAX_CONSECUTIVE_FAILURES = 3; // likely rate-limited; stop instead of hammering
const BUDGET_NOTE = `已達 ${BUDGET_MS / 1000} 秒時間上限，提前停止。`;

interface StockDayResponse {
  stat: string;
  data?: string[][];
}

/** One month of one ticker. Past months are final and go to the disk cache. */
async function getMonthPrices(ticker: string, monthStart: Date, deadline: number): Promise<DailyPriceRow[]> {
  const ymd = toYyyymmdd(monthStart);
  const url = `${RWD_BASE}/afterTrading/STOCK_DAY?response=json&date=${ymd}&stockNo=${encodeURIComponent(ticker)}`;
  return getOrFetchDisk<DailyPriceRow[]>(
    `twse-STOCK_DAY-${ticker}-${ymd.slice(0, 6)}`,
    async () => {
      const json = await fetchJson<StockDayResponse>(url, { retries: 2, deadline });
      if (json.stat.includes("沒有符合條件")) return []; // no trading that month (e.g. before listing)
      if (json.stat !== "OK" || !json.data) throw new UpstreamError(`TWSE stat: ${json.stat}`, url);
      return json.data.map((cols) => ({
        date: rocToIso(cols[0]),
        volume: parseTwNumber(cols[1]),
        open: parseTwNumber(cols[3]),
        high: parseTwNumber(cols[4]),
        low: parseTwNumber(cols[5]),
        close: parseTwNumber(cols[6]),
        average: null,
        transactionCount: parseTwNumber(cols[8]),
      }));
    },
    () => ymd.slice(0, 6) < taipeiTodayYmd().slice(0, 6)
  );
}

/**
 * One HTTP call per calendar month, newest month first so a partial result is
 * the most recent stretch. A failed month is skipped; stops at the time budget.
 */
export async function getDailyPrice(
  ticker: string,
  startIso: string,
  endIso: string
): Promise<DailySeries<DailyPriceRow>> {
  const deadline = Date.now() + BUDGET_MS;
  const monthLabel = (m: Date) => toIsoDate(m).slice(0, 7);
  const months = enumerateMonths(parseIsoDate(startIso), parseIsoDate(endIso)).reverse();
  const rows: DailyPriceRow[] = [];
  const failed: string[] = [];
  let stopReason = "";
  let streak = 0;

  for (const [i, monthStart] of months.entries()) {
    if (Date.now() >= deadline) {
      stopReason = `${BUDGET_NOTE}未抓取：${monthLabel(months.at(-1)!)} 至 ${monthLabel(months[i])}。`;
      break;
    }
    try {
      const month = await getMonthPrices(ticker, monthStart, deadline);
      streak = 0;
      rows.push(...month.filter((r) => r.date >= startIso && r.date <= endIso));
    } catch {
      if (Date.now() >= deadline - 1_000) {
        stopReason = `${BUDGET_NOTE}未抓取：${monthLabel(months.at(-1)!)} 至 ${monthLabel(months[i])}。`;
        break;
      }
      failed.push(monthLabel(monthStart));
      if (++streak >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `連續 ${streak} 個月請求失敗（證交所可能限流），提前停止。`;
        break;
      }
    }
  }

  const notes: string[] = [];
  if (failed.length) notes.push(`以下月份抓取失敗：${failed.join(", ")}。`);
  if (stopReason) notes.push(stopReason);
  if (notes.length) notes.push("已抓到的月份已快取，稍後再查一次即可補齊。");
  return {
    rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
    limitationNote: notes.length ? notes.join(" ") : undefined,
  };
}

const MAX_DAILY_LOOKBACK = 40; // cap fan-out for per-day endpoints (T86 / margin)

interface DayResponse {
  stat: string;
  data?: string[][];
}

/** ticker -> the selected columns of that day's whole-market table; null = no session that day. */
type DaySnapshot = Record<string, string[]> | null;

function taipeiTodayYmd(): string {
  return toYyyymmdd(new Date(Date.now() + 8 * 60 * 60 * 1000));
}

/**
 * T86 / TWT93U return the whole market for one day, so one fetch serves every
 * ticker. Published sessions are final and go to the disk cache; "no data" is
 * persisted only for past days (holidays) — today's may just not be published yet.
 */
async function getDaySnapshot(
  name: string,
  url: string,
  cols: number[],
  day: Date,
  deadline: number
): Promise<DaySnapshot> {
  const ymd = toYyyymmdd(day);
  return getOrFetchDisk<DaySnapshot>(
    `twse-${name}-${ymd}`,
    async () => {
      const json = await fetchJson<DayResponse>(url, { retries: 2, deadline });
      if (json.stat === "OK" && json.data) {
        return Object.fromEntries(json.data.map((r) => [r[0].trim(), cols.map((i) => r[i])]));
      }
      if (json.stat.includes("沒有符合條件")) return null; // holiday / no session
      throw new UpstreamError(`TWSE stat: ${json.stat}`, url);
    },
    (snap) => snap !== null || ymd < taipeiTodayYmd()
  );
}

export interface DailySeries<R> {
  rows: R[];
  limitationNote?: string;
}

/**
 * Walks weekdays newest-first until `days` sessions are found. A failed day is
 * recorded and skipped instead of failing the call; stops at the time budget
 * and returns whatever was collected.
 */
async function collectDaily<R extends { date: string }>(
  name: string,
  urlFor: (ymd: string) => string,
  cols: number[],
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
      const snap = await getDaySnapshot(name, urlFor(toYyyymmdd(day)), cols, day, deadline);
      streak = 0;
      const v = snap?.[ticker];
      if (v) rows.push(toRow(toIsoDate(day), v));
    } catch {
      if (Date.now() >= deadline - 1_000) {
        stopReason = BUDGET_NOTE;
        break;
      }
      failed.push(toIsoDate(day));
      if (++streak >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `連續 ${streak} 天請求失敗（證交所可能限流），提前停止。`;
        break;
      }
    }
  }

  const notes: string[] = [];
  if (rows.length < days) notes.push(`要求 ${days} 個交易日，實得 ${rows.length} 個。`);
  if (failed.length) notes.push(`以下日期抓取失敗（可能是交易日或假日）：${failed.join(", ")}。`);
  if (stopReason) notes.push(stopReason);
  if (notes.length) notes.push("已抓到的收盤日資料已快取，稍後再查一次即可補齊。");
  return {
    rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
    limitationNote: notes.length ? notes.join(" ") : undefined,
  };
}

// T86 columns: 4 外陸資(不含自營) 7 外資自營 10 投信 11 自營商 18 三大法人合計
const T86_COLS = [4, 7, 10, 11, 18];

export function getInstitutionalFlows(
  ticker: string,
  days: number
): Promise<DailySeries<InstitutionalFlowRow>> {
  return collectDaily(
    "T86",
    // ALLBUT0999 = 不含權證/牛熊證: ~1.3k rows vs ~16k, ~7x faster; stocks and ETFs are all still there
    (ymd) => `${RWD_BASE}/fund/T86?response=json&date=${ymd}&selectType=ALLBUT0999`,
    T86_COLS,
    ticker,
    days,
    (date, v) => ({
      date,
      foreignNet: (parseTwNumber(v[0]) ?? 0) + (parseTwNumber(v[1]) ?? 0),
      investmentTrustNet: parseTwNumber(v[2]),
      dealerNet: parseTwNumber(v[3]),
      totalNet: parseTwNumber(v[4]),
    })
  );
}

// TWT93U columns: 3 融資賣出 4 融資買進 6 融資餘額 9 融券賣出 10 融券買進 12 融券餘額
const MARGIN_COLS = [3, 4, 6, 9, 10, 12];

export function getMarginTrading(ticker: string, days: number): Promise<DailySeries<MarginTradingRow>> {
  return collectDaily(
    "TWT93U",
    // stockNo is ignored upstream (whole market is returned), so the URL — and cache — is per day only
    (ymd) => `${RWD_BASE}/marginTrading/TWT93U?response=json&date=${ymd}`,
    MARGIN_COLS,
    ticker,
    days,
    (date, v) => ({
      date,
      marginSell: parseTwNumber(v[0]),
      marginBuy: parseTwNumber(v[1]),
      marginBalance: parseTwNumber(v[2]),
      shortSell: parseTwNumber(v[3]),
      shortBuy: parseTwNumber(v[4]),
      shortBalance: parseTwNumber(v[5]),
    })
  );
}
